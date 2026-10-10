"""
Por la sombra · datos de la app (los lee js/motor.js).

Entradas:
  - build/osm.pkl: OpenStreetMap del municipio (scripts/extraer_osm.py).
  - Catastro INSPIRE de Marbella (29069): cuerpos de edificio con nº de plantas. Se descarga del
    ATOM del Catastro, o se reutiliza el GML ya descargado si CATASTRO_DIR apunta a él.
  - Relieve: data/relieve.pmtiles del Gemelo Digital de Marbella (terrarium z14), para la cota de
    cada cruce y la velocidad con pendiente. Ruta local en RELIEVE_PMTILES o se descarga de la web
    del gemelo.

Salidas (data/):
  red.bin.gz         red peatonal: cruces con cota, tramos con geometría, tipo, aceras y nombre
  edificios.bin.gz   cuerpos de edificio: huella y altura (3 m por planta + 1 m)
  vegetacion.bin.gz  árboles sueltos, hileras (un árbol cada 8 m) y masas arboladas
  buscador.json      calles, zonas y lugares con nombre
  termino.geojson    término municipal (simplificado)
  meta.json          plano de coordenadas, fechas, fuentes y totales

Formato de los .bin: contenedor 'PLS1' (ver leerPLS en js/motor.js), comprimido con gzip.
"""

import gzip, io, json, math, os, pickle, sys, urllib.request, zipfile
from collections import Counter, defaultdict
from datetime import date

import numpy as np

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("CACHE_DIR", os.path.join(BASE, "build"))
DATA = os.path.join(BASE, "data")
URL_CATASTRO = "https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/29/29069-MARBELLA/A.ES.SDGC.BU.29069.zip"
URL_RELIEVE = "https://josehino.github.io/gemelo-digital-marbella/data/relieve.pmtiles"

# plano local: x al este, y al norte, en metros, alrededor de (LON0, LAT0)
LON0, LAT0 = -4.90, 36.52
_f = math.radians(LAT0)
KY = 111132.92 - 559.82 * math.cos(2 * _f) + 1.175 * math.cos(4 * _f)
KX = 111412.84 * math.cos(_f) - 93.5 * math.cos(3 * _f) + 0.118 * math.cos(5 * _f)

H_PLANTA, H_EXTRA = 3.0, 1.0       # m por planta y remate (planta baja más alta, pretil)
MARGEN_TERMINO = 400               # m alrededor del término municipal que entran en la red

# banderas de tramo (las mismas que F en js/motor.js)
ESCALERA, CUBIERTO, IZQ, DER, CENTRO, ACERA_APARTE, PUENTE, CRUCE = 1, 2, 4, 8, 16, 32, 64, 128

PEATONAL = {"footway", "path", "pedestrian", "steps", "cycleway", "track", "platform", "corridor", "bridleway"}
CALZADA = {"living_street": 1, "service": 1, "residential": 2, "unclassified": 2, "road": 2,
           "tertiary": 3, "tertiary_link": 3, "secondary": 4, "secondary_link": 4,
           "primary": 5, "primary_link": 5, "trunk": 5, "trunk_link": 5}
ANCHO_TIPO = {"living_street": 5, "service": 4, "residential": 6.5, "unclassified": 6, "road": 6,
              "tertiary": 8, "tertiary_link": 6, "secondary": 10, "secondary_link": 7,
              "primary": 12, "primary_link": 7, "trunk": 14, "trunk_link": 7}


def xy(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def numero(v):
    try:
        return float(str(v).replace(",", ".").split()[0].rstrip("m"))
    except (ValueError, IndexError):
        return None


# ------------------------------------------------------------------ contenedor PLS1
def escribir_pls(ruta, arrays, cab=None):
    cab = dict(cab or {})
    cab["arrays"], datos, off = [], [], 0
    for nombre, a in arrays.items():
        a = np.ascontiguousarray(a)
        tipo = {np.dtype("int32"): "int32", np.dtype("uint32"): "uint32", np.dtype("int16"): "int16",
                np.dtype("uint16"): "uint16", np.dtype("uint8"): "uint8", np.dtype("int8"): "int8",
                np.dtype("float32"): "float32"}[a.dtype]
        b = a.astype(a.dtype.newbyteorder("<"), copy=False).tobytes()
        cab["arrays"].append({"name": nombre, "type": tipo, "length": int(a.size), "offset": off})
        datos.append(b + b"\0" * ((4 - len(b) % 4) % 4))
        off += len(datos[-1])
    jc = json.dumps(cab, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    cuerpo = b"PLS1" + len(jc).to_bytes(4, "little") + jc + b"\0" * ((4 - len(jc) % 4) % 4) + b"".join(datos)
    with gzip.open(ruta, "wb", compresslevel=9) as f:
        f.write(cuerpo)
    return os.path.getsize(ruta)


def delta_anillo(pts_dm):
    """Primer vértice absoluto y el resto como incrementos int16 (parte los lados muy largos)."""
    out = [pts_dm[0]]
    for p in pts_dm[1:]:
        q = out[-1]
        dx, dy = p[0] - q[0], p[1] - q[1]
        n = max(1, math.ceil(max(abs(dx), abs(dy)) / 30000))
        for k in range(1, n + 1):
            out.append((q[0] + round(dx * k / n), q[1] + round(dy * k / n)))
    d = np.diff(np.array(out, dtype=np.int64), axis=0)
    return out[0], d.astype(np.int16).ravel(), len(out)


# ------------------------------------------------------------------ término municipal
def termino_poligono(osm):
    from shapely.geometry import MultiPolygon, Polygon
    pols = [Polygon(ext, holes) for ext, holes in osm["termino"]]
    return MultiPolygon(pols) if len(pols) > 1 else pols[0]


# ------------------------------------------------------------------ relieve
class Relieve:
    def __init__(self):
        from pmtiles.reader import MmapSource, Reader
        ruta = os.environ.get("RELIEVE_PMTILES") or os.path.join(CACHE, "relieve.pmtiles")
        if not os.path.exists(ruta):
            print("Descargando el relieve del gemelo digital...", flush=True)
            os.makedirs(CACHE, exist_ok=True)
            urllib.request.urlretrieve(URL_RELIEVE, ruta)
        self.f = open(ruta, "rb")
        self.r = Reader(MmapSource(self.f))
        self.cache = {}

    def cota(self, lon, lat, z=14):
        from PIL import Image
        n = 2 ** z
        x = (lon + 180) / 360 * n
        y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        k = (int(x), int(y))
        if k not in self.cache:
            t = self.r.get(z, *k)
            self.cache[k] = None if t is None else np.asarray(Image.open(io.BytesIO(t)).convert("RGB"), dtype=np.float64)
        a = self.cache[k]
        if a is None:
            return 0.0
        s = a.shape[0]
        px, py = min(s - 1, int((x % 1) * s)), min(s - 1, int((y % 1) * s))
        r, g, b = a[py, px]
        v = r * 256 + g + b / 256 - 32768
        return v if -100 < v < 3500 else 0.0


# ------------------------------------------------------------------ red peatonal
def andable(tg):
    hw = tg.get("highway")
    foot, access = tg.get("foot"), tg.get("access")
    if foot in ("no", "private", "use_sidepath"):
        return False
    if access in ("no", "private") and foot not in ("yes", "designated", "permissive"):
        return False
    if tg.get("area") == "yes" and hw not in ("pedestrian", "footway"):
        return False
    if hw in ("trunk", "trunk_link"):
        return foot in ("yes", "designated", "permissive") or tg.get("sidewalk") in ("both", "left", "right", "yes")
    return hw in PEATONAL or hw in CALZADA


def atributos(tg):
    """(cls, flags, desplazamiento de la acera en m) de una vía."""
    hw = tg["highway"]
    flags = 0
    if hw == "steps":
        flags |= ESCALERA
    if tg.get("covered") in ("yes", "arcade", "colonnade") or tg.get("tunnel") in ("yes", "building_passage"):
        flags |= CUBIERTO
    if tg.get("bridge") in ("yes", "viaduct", "boardwalk"):
        flags |= PUENTE
    if tg.get("footway") == "crossing" or tg.get("cycleway") == "crossing":
        flags |= CRUCE
    ancho = numero(tg.get("width"))
    if hw in PEATONAL:
        if hw == "pedestrian":           # calle peatonal: se puede ir por el centro o pegado a las fachadas
            a = ancho if ancho and ancho > 2 else 6
            return 0, flags | CENTRO | IZQ | DER, max(1.0, a / 2 - 1)
        return 0, flags | CENTRO, 0.0
    cls = CALZADA[hw]
    if not ancho or ancho < 2.5 or ancho > 40:
        carriles = numero(tg.get("lanes"))
        if carriles and 1 <= carriles <= 8:
            ancho = carriles * 3.2
        else:
            ancho = ANCHO_TIPO[hw] * (0.75 if tg.get("oneway") in ("yes", "-1") else 1)
    acera = tg.get("sidewalk") or tg.get("sidewalk:both")
    izq, der = tg.get("sidewalk:left"), tg.get("sidewalk:right")
    if acera is None and (izq or der):
        acera = "both" if izq == der == "yes" else "left" if izq in ("yes",) else "right" if der in ("yes",) else \
            "separate" if "separate" in (izq, der) else None
    if acera == "separate":
        return cls, flags | CENTRO | ACERA_APARTE, 0.0
    if hw in ("living_street", "service"):
        return cls, flags | CENTRO | IZQ | DER, max(1.0, ancho / 2 - 0.5)
    if acera == "left":
        return cls, flags | IZQ, min(20, ancho / 2 + 1.5)
    if acera == "right":
        return cls, flags | DER, min(20, ancho / 2 + 1.5)
    if acera in ("no", "none"):
        return cls, flags | IZQ | DER, max(1.0, ancho / 2 - 0.5)
    return cls, flags | IZQ | DER, min(20, ancho / 2 + 1.5)


def construir_red(osm, zona, relieve):
    from shapely.geometry import LineString, Point
    from shapely.strtree import STRtree
    from shapely.prepared import prep
    zona_p = prep(zona)
    vias = []
    for wid, refs, coords, tg in osm["vias"]:
        if not andable(tg) or len(refs) != len(coords) or len(refs) < 2:
            continue
        if not any(zona_p.contains(Point(c)) for c in coords[:: max(1, len(coords) // 6)] + [coords[-1]]):
            continue
        vias.append((wid, refs, coords, tg))
    print(f"Vías por las que se puede andar: {len(vias)}", flush=True)

    # aceras sin nombre: el de la calzada con nombre más cercana (a menos de 25 m)
    calzadas = [(LineString([xy(*c) for c in coords]), tg["name"]) for _, _, coords, tg in vias
                if tg.get("name") and tg["highway"] in CALZADA]
    arbol = STRtree([g for g, _ in calzadas])
    nombre_acera = {}
    for wid, refs, coords, tg in vias:
        if tg.get("name") or tg.get("footway") != "sidewalk":
            continue
        g = LineString([xy(*c) for c in coords])
        i = arbol.nearest(g.interpolate(0.5, normalized=True))
        if i is not None and calzadas[i][0].distance(g.interpolate(0.5, normalized=True)) < 25:
            nombre_acera[wid] = calzadas[i][1]

    uso = Counter()
    for _, refs, _, _ in vias:
        uso.update(refs)
        uso[refs[0]] += 1; uso[refs[-1]] += 1
    nodos, pos = {}, {}
    def nodo(ref, c):
        if ref not in nodos:
            nodos[ref] = len(nodos); pos[ref] = c
        return nodos[ref]
    tramos = []            # (a, b, [coords intermedias], cls, flags, off, nombre)
    for wid, refs, coords, tg in vias:
        cls, flags, off = atributos(tg)
        nombre = tg.get("name") or nombre_acera.get(wid, "")
        ini = 0
        for k in range(1, len(refs)):
            if uso[refs[k]] >= 2 or k == len(refs) - 1:
                if refs[ini] != refs[k] or k - ini > 1:
                    tramos.append((nodo(refs[ini], coords[ini]), nodo(refs[k], coords[k]), coords[ini + 1:k],
                                   cls, flags, off, nombre))
                ini = k
    # quita bucles de un solo punto y se queda con la componente conexa mayor
    tramos = [t for t in tramos if t[0] != t[1] or len(t[2]) >= 2]
    padre = list(range(len(nodos)))
    def raiz(i):
        while padre[i] != i:
            padre[i] = padre[padre[i]]; i = padre[i]
        return i
    for a, b, *_ in tramos:
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            padre[ra] = rb
    tam = Counter(raiz(i) for i in range(len(nodos)))
    mayor = tam.most_common(1)[0][0]
    print(f"Componentes: {len(tam)}; la mayor tiene {tam[mayor]} de {len(nodos)} cruces", flush=True)
    tramos = [t for t in tramos if raiz(t[0]) == mayor]
    usados = sorted({t[0] for t in tramos} | {t[1] for t in tramos})
    nuevo = {v: i for i, v in enumerate(usados)}
    inv_ref = {v: k for k, v in nodos.items()}

    N = len(usados)
    nx = np.zeros(N, np.int32); ny = np.zeros(N, np.int32); nz = np.zeros(N, np.int16)
    for v, i in nuevo.items():
        lon, lat = pos[inv_ref[v]]
        x, y = xy(lon, lat)
        nx[i], ny[i] = round(x * 10), round(y * 10)
        nz[i] = max(-3000, min(30000, round(relieve.cota(lon, lat) * 10)))
    nombres = [""]
    idx_nombre = {"": 0}
    E = len(tramos)
    ea = np.zeros(E, np.uint32); eb = np.zeros(E, np.uint32); eg0 = np.zeros(E, np.uint32); egn = np.zeros(E, np.uint16)
    ecls = np.zeros(E, np.uint8); efl = np.zeros(E, np.uint8); eoff = np.zeros(E, np.uint8); enom = np.zeros(E, np.uint32)
    gd = []
    ng = 0
    longitud = km_aceras = 0.0
    for e, (a, b, inter, cls, flags, off, nombre) in enumerate(tramos):
        l0 = longitud
        ea[e], eb[e] = nuevo[a], nuevo[b]
        prev = (int(nx[ea[e]]), int(ny[ea[e]]))
        pts = []
        for c in inter:
            x, y = xy(*c)
            p = (round(x * 10), round(y * 10))
            # los lados de más de 3 km se parten para que el incremento quepa en int16
            n = max(1, math.ceil(max(abs(p[0] - prev[0]), abs(p[1] - prev[1])) / 30000))
            for k in range(1, n + 1):
                q = (prev[0] + round((p[0] - prev[0]) * k / n), prev[1] + round((p[1] - prev[1]) * k / n))
                pts.append(q)
            prev = p
        fin = (int(nx[eb[e]]), int(ny[eb[e]]))
        if max(abs(fin[0] - prev[0]), abs(fin[1] - prev[1])) > 30000:
            n = math.ceil(max(abs(fin[0] - prev[0]), abs(fin[1] - prev[1])) / 30000)
            for k in range(1, n):
                pts.append((prev[0] + round((fin[0] - prev[0]) * k / n), prev[1] + round((fin[1] - prev[1]) * k / n)))
        eg0[e], egn[e] = ng, len(pts)
        q = (int(nx[ea[e]]), int(ny[ea[e]]))
        for p in pts:
            gd += [p[0] - q[0], p[1] - q[1]]
            longitud += math.hypot(p[0] - q[0], p[1] - q[1]) / 10
            q = p
        longitud += math.hypot(fin[0] - q[0], fin[1] - q[1]) / 10
        ng += len(pts)
        if flags & (IZQ | DER) and not flags & CENTRO:
            km_aceras += longitud - l0
        ecls[e], efl[e], eoff[e] = cls, flags, min(255, round(off * 10))
        if nombre not in idx_nombre:
            idx_nombre[nombre] = len(nombres); nombres.append(nombre)
        enom[e] = idx_nombre[nombre]
    gd = np.array(gd, np.int16)
    arrays = {"nx": nx, "ny": ny, "nz": nz, "ea": ea, "eb": eb, "eg0": eg0, "egn": egn, "gd": gd,
              "ecls": ecls, "eflags": efl, "eoff": eoff, "enom": enom}
    tam_b = escribir_pls(os.path.join(DATA, "red.bin.gz"), arrays, {"nombres": nombres})
    print(f"Red: {N} cruces, {E} tramos, {longitud / 1000:.0f} km -> red.bin.gz ({tam_b / 1e6:.1f} MB)", flush=True)
    return {"cruces": N, "tramos": E, "km": round(longitud / 1000), "km_calzada_con_aceras": round(km_aceras / 1000)}


# ------------------------------------------------------------------ edificios (Catastro)
def construir_edificios():
    import geopandas as gpd
    import pyogrio
    dir_cat = os.environ.get("CATASTRO_DIR") or os.path.join(CACHE, "catastro")
    gml = os.path.join(dir_cat, "A.ES.SDGC.BU.29069.buildingpart.gml")
    if not os.path.exists(gml):
        print("Descargando edificios del Catastro (ATOM INSPIRE)...", flush=True)
        os.makedirs(dir_cat, exist_ok=True)
        req = urllib.request.Request(URL_CATASTRO, headers={"User-Agent": "Mozilla/5.0"})
        zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=900).read())).extractall(dir_cat)
    partes = pyogrio.read_dataframe(gml, columns=["localId", "numberOfFloorsAboveGround"])
    print(f"Cuerpos de edificio en el Catastro: {len(partes)}", flush=True)
    partes = partes[partes["numberOfFloorsAboveGround"].fillna(0).astype(int) > 0].copy()
    partes["rc"] = partes["localId"].str.split("_").str[0]
    partes["pl"] = partes["numberOfFloorsAboveGround"].astype(int)
    # une los cuerpos contiguos de un edificio con el mismo nº de plantas (menos aristas que sombrear)
    partes = partes.dissolve(by=["rc", "pl"], as_index=False).explode(index_parts=False)
    assert partes.crs.is_projected, partes.crs
    partes["geometry"] = partes.geometry.simplify(0.3)
    partes = partes[partes.geometry.area >= 4].to_crs(4326)
    filas = []
    for pl, g in zip(partes["pl"], partes.geometry):
        if g is None or g.is_empty:
            continue
        anillo = list(g.exterior.coords)[:-1]
        if len(anillo) < 3:
            continue
        pts = [(round(xy(lon, lat)[0] * 10), round(xy(lon, lat)[1] * 10)) for lon, lat in anillo]
        cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
        filas.append(((int(cy // 2560), int(cx // 2560)), pl, pts))
    filas.sort(key=lambda f: f[0])
    n = len(filas)
    h = np.zeros(n, np.uint16); nv = np.zeros(n, np.uint16); x0 = np.zeros(n, np.int32); y0 = np.zeros(n, np.int32)
    ds = []
    pl_max = 0
    for i, (_, pl, pts) in enumerate(filas):
        (px, py), d, m = delta_anillo(pts)
        h[i] = round((pl * H_PLANTA + H_EXTRA) * 10); nv[i] = m; x0[i], y0[i] = px, py
        ds.append(d)
        pl_max = max(pl_max, pl)
    d = np.concatenate(ds).astype(np.int16)
    tam = escribir_pls(os.path.join(DATA, "edificios.bin.gz"), {"h": h, "nv": nv, "x0": x0, "y0": y0, "d": d},
                       {"h_planta": H_PLANTA, "h_extra": H_EXTRA})
    print(f"Edificios: {n} cuerpos, {int(nv.sum())} vértices, hasta {pl_max} plantas -> edificios.bin.gz ({tam / 1e6:.1f} MB)",
          flush=True)
    return {"cuerpos": n, "plantas_max": int(pl_max)}


# ------------------------------------------------------------------ vegetación (OSM)
def tipo_arbol(tg):
    t = " ".join(str(tg.get(k, "")) for k in ("leaf_type", "genus", "species", "taxon", "taxon:es", "species:es")).lower()
    if any(p in t for p in ("palm", "phoenix", "washingtonia", "trachycarpus", "syagrus", "archontophoenix", "chamaerops")):
        return 1
    if any(p in t for p in ("needleleaved", "pinus", "pino", "cupressus", "ciprés", "cedrus", "araucaria")):
        return 2
    return 0


def construir_vegetacion(osm, zona):
    from shapely.geometry import LineString, Point, Polygon
    from shapely.prepared import prep
    zona_p = prep(zona)
    arboles = []
    for _, lon, lat, tg in osm["nodos"]:
        if tg.get("natural") != "tree" or not zona_p.contains(Point(lon, lat)):
            continue
        t = tipo_arbol(tg)
        alto = numero(tg.get("height")) or (9 if t == 1 else 10 if t == 2 else 7)
        copa = numero(tg.get("diameter_crown"))
        r = copa / 2 if copa else (2.5 if t in (1, 2) else 3)
        arboles.append((*xy(lon, lat), r, alto, t))
    sueltos = len(arboles)
    for _, coords, tg in osm["hileras"]:
        g = LineString([xy(*c) for c in coords])
        if not zona_p.intersects(LineString(coords)):
            continue
        t = tipo_arbol(tg)
        alto = numero(tg.get("height")) or (9 if t == 1 else 7)
        for k in range(int(g.length // 8) + 1):
            p = g.interpolate(min(g.length, 4 + k * 8))
            arboles.append((p.x, p.y, 2.5 if t == 1 else 3, alto, t))
    bosques = []
    for _, pols, tg in osm["areas"]:
        if not (tg.get("natural") == "wood" or tg.get("landuse") == "forest"):
            continue
        for ext, _ in pols:
            if len(ext) < 4:
                continue
            p = Polygon([xy(*c) for c in ext]).simplify(2.0)
            if p.is_empty or p.area < 50 or not zona.intersects(Polygon(ext)):
                continue
            ps = [p] if p.geom_type == "Polygon" else list(p.geoms)
            for q in ps:
                anillo = list(q.exterior.coords)[:-1]
                if len(anillo) >= 3:
                    alto = numero(tg.get("height")) or 9
                    bosques.append(([(round(x * 10), round(y * 10)) for x, y in anillo], alto))
    A = np.array([(round(x * 10), round(y * 10)) for x, y, *_ in arboles], np.int32).reshape(-1, 2)
    arrays = {"tx": A[:, 0].copy(), "ty": A[:, 1].copy(),
              "tr": np.array([min(255, round(r * 10)) for _, _, r, _, _ in arboles], np.uint8),
              "th": np.array([min(65535, round(h * 10)) for _, _, _, h, _ in arboles], np.uint16),
              "tt": np.array([t for *_, t in arboles], np.uint8)}
    bnv, bx0, by0, bh, bd = [], [], [], [], []
    for pts, alto in bosques:
        (px, py), d, m = delta_anillo(pts)
        bnv.append(m); bx0.append(px); by0.append(py); bh.append(round(alto * 10)); bd.append(d)
    arrays.update({"bnv": np.array(bnv, np.uint32), "bx0": np.array(bx0, np.int32), "by0": np.array(by0, np.int32),
                   "bh": np.array(bh, np.uint16), "bd": np.concatenate(bd).astype(np.int16) if bd else np.zeros(0, np.int16)})
    tam = escribir_pls(os.path.join(DATA, "vegetacion.bin.gz"), arrays)
    print(f"Vegetación: {sueltos} árboles sueltos, {len(arboles) - sueltos} en hileras, {len(bosques)} masas arboladas "
          f"-> vegetacion.bin.gz ({tam / 1e3:.0f} kB)", flush=True)
    return {"arboles": sueltos, "arboles_hileras": len(arboles) - sueltos, "masas": len(bosques)}


# ------------------------------------------------------------------ buscador
CATEGORIAS = {
    "amenity": {"restaurant": "Restaurante", "bar": "Bar", "cafe": "Cafetería", "fast_food": "Comida rápida", "pub": "Pub",
                "ice_cream": "Heladería", "pharmacy": "Farmacia", "hospital": "Hospital", "clinic": "Clínica",
                "doctors": "Consulta médica", "dentist": "Dentista", "school": "Colegio", "kindergarten": "Escuela infantil",
                "college": "Centro de estudios", "university": "Universidad", "library": "Biblioteca",
                "townhall": "Ayuntamiento", "police": "Policía", "fire_station": "Bomberos", "post_office": "Correos",
                "bank": "Banco", "place_of_worship": "Templo", "marketplace": "Mercado", "theatre": "Teatro",
                "cinema": "Cine", "arts_centre": "Centro cultural", "community_centre": "Centro social",
                "social_facility": "Servicios sociales", "bus_station": "Estación de autobuses", "taxi": "Parada de taxis",
                "parking": "Aparcamiento", "fuel": "Gasolinera", "nightclub": "Discoteca", "casino": "Casino",
                "courthouse": "Juzgado", "embassy": "Consulado", "veterinary": "Veterinario", "car_rental": "Alquiler de coches",
                "ferry_terminal": "Terminal marítima", "toilets": "Aseos", "drinking_water": "Fuente", "fountain": "Fuente",
                "public_building": "Edificio público", "events_venue": "Sala de eventos", "language_school": "Academia",
                "driving_school": "Autoescuela", "music_school": "Escuela de música", "nursing_home": "Residencia"},
    "tourism": {"hotel": "Hotel", "apartment": "Apartamentos", "guest_house": "Hostal", "hostel": "Albergue",
                "motel": "Motel", "museum": "Museo", "attraction": "Lugar de interés", "viewpoint": "Mirador",
                "gallery": "Galería de arte", "information": "Información turística", "artwork": "Obra de arte",
                "camp_site": "Camping", "picnic_site": "Merendero", "theme_park": "Parque temático", "zoo": "Zoo"},
    "leisure": {"park": "Parque", "garden": "Jardín", "playground": "Parque infantil", "sports_centre": "Polideportivo",
                "stadium": "Estadio", "golf_course": "Campo de golf", "marina": "Puerto deportivo", "pitch": "Pista deportiva",
                "swimming_pool": "Piscina", "fitness_centre": "Gimnasio", "beach_resort": "Club de playa",
                "nature_reserve": "Espacio natural", "dog_park": "Parque canino", "track": "Pista", "sports_hall": "Pabellón"},
    "historic": {"monument": "Monumento", "castle": "Castillo", "ruins": "Ruinas", "memorial": "Memorial",
                 "archaeological_site": "Yacimiento", "church": "Iglesia", "tower": "Torre", "building": "Edificio histórico"},
    "natural": {"beach": "Playa", "peak": "Cumbre", "cape": "Punta", "bay": "Ensenada"},
    "man_made": {"lighthouse": "Faro", "pier": "Espigón", "breakwater": "Espigón", "tower": "Torre", "water_tower": "Torre"},
    "healthcare": {"centre": "Centro de salud", "hospital": "Hospital", "clinic": "Clínica", "pharmacy": "Farmacia",
                   "doctor": "Consulta médica", "dentist": "Dentista", "physiotherapist": "Fisioterapia"},
    "place": {"suburb": "Zona", "neighbourhood": "Barrio", "quarter": "Barrio", "locality": "Paraje",
              "village": "Núcleo", "hamlet": "Núcleo", "town": "Núcleo", "city": "Ciudad", "square": "Plaza"},
    "shop": {"supermarket": "Supermercado", "convenience": "Tienda de alimentación", "bakery": "Panadería",
             "mall": "Centro comercial", "department_store": "Grandes almacenes", "clothes": "Tienda de ropa",
             "optician": "Óptica", "hairdresser": "Peluquería", "butcher": "Carnicería", "greengrocer": "Frutería"},
}


def categoria(tg):
    if tg.get("highway") == "bus_stop" or tg.get("public_transport") == "platform" and tg.get("bus") == "yes":
        return "Parada de autobús"
    for k, tabla in CATEGORIAS.items():
        v = tg.get(k)
        if v:
            if v in tabla:
                return tabla[v]
            if k == "shop":
                return "Tienda"
    if tg.get("office"):
        return "Oficina"
    if tg.get("highway") == "pedestrian":
        return "Plaza" if "plaza" in tg.get("name", "").lower() else "Calle peatonal"
    return None


def construir_buscador(osm, zona):
    from shapely.geometry import MultiLineString, Point, Polygon
    from shapely.prepared import prep
    zona_p = prep(zona)
    # contexto: núcleo o zona más cercana
    lugares = [(xy(lon, lat), tg["name"]) for _, lon, lat, tg in osm["nodos"]
               if tg.get("place") in ("city", "town", "village", "suburb", "quarter") and tg.get("name")]
    barrios = [(xy(lon, lat), tg["name"]) for _, lon, lat, tg in osm["nodos"]
               if tg.get("place") in ("neighbourhood", "locality", "hamlet") and tg.get("name")]
    def contexto(x, y):
        best, bd = "", 2500.0
        for (px, py), nombre in lugares:
            d = math.hypot(px - x, py - y)
            if d < bd:
                best, bd = nombre, d
        return best

    items = []
    # calles: por nombre, agrupadas por cercanía (calles homónimas en San Pedro y en Marbella)
    por_nombre = defaultdict(list)
    for _, _, coords, tg in osm["vias"]:
        n = tg.get("name")
        if n and tg.get("highway") not in ("motorway", "motorway_link", "construction", "proposed", "bus_stop") \
                and any(zona_p.contains(Point(c)) for c in coords[:: max(1, len(coords) // 4)]):
            por_nombre[n].append([xy(*c) for c in coords])
    for nombre, lineas in por_nombre.items():
        grupos = []
        for l in lineas:
            cx, cy = l[len(l) // 2]
            for g in grupos:
                if any(math.hypot(cx - p[0], cy - p[1]) < 400 for ll in g for p in ll[:: max(1, len(ll) // 5)] + [ll[-1]]):
                    g.append(l); break
            else:
                grupos.append([l])
        for g in grupos:
            pts = [p for l in g for p in l]
            mx, my = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            px, py = min(pts, key=lambda p: math.hypot(p[0] - mx, p[1] - my))
            items.append([nombre, "Calle", round(px * 10), round(py * 10), contexto(px, py)])
    calles = len(items)
    # lugares y puntos de interés
    vistos = {}
    def añade(nombre, cat, x, y):
        k = (nombre.lower(), cat)
        for (px, py) in vistos.get(k, []):
            if math.hypot(px - x, py - y) < 80:
                return
        vistos.setdefault(k, []).append((x, y))
        items.append([nombre, cat, round(x * 10), round(y * 10), contexto(x, y)])
    for _, lon, lat, tg in osm["nodos"]:
        if not tg.get("name") or not zona_p.contains(Point(lon, lat)):
            continue
        cat = categoria(tg)
        if cat:
            añade(tg["name"], cat, *xy(lon, lat))
    for _, pols, tg in osm["areas"]:
        if not tg.get("name"):
            continue
        cat = categoria(tg)
        if not cat:
            continue
        try:
            p = max((Polygon(e, h) for e, h in pols), key=lambda q: q.area)
        except Exception:
            continue
        c = p.representative_point()
        if zona_p.contains(c):
            añade(tg["name"], cat, *xy(c.x, c.y))
    print(f"Buscador: {calles} calles y {len(items) - calles} lugares", flush=True)
    with open(os.path.join(DATA, "buscador.json"), "w", encoding="utf8") as f:
        json.dump({"v": 1, "items": items}, f, ensure_ascii=False, separators=(",", ":"))
    return {"calles": calles, "lugares": len(items) - calles}


# ------------------------------------------------------------------ principal
def main():
    from shapely.geometry import mapping
    os.makedirs(DATA, exist_ok=True)
    osm = pickle.load(open(os.path.join(CACHE, "osm.pkl"), "rb"))
    termino = termino_poligono(osm)
    # zona de trabajo: el término con un margen (en grados, aproximado)
    zona = termino.buffer(MARGEN_TERMINO / KY)
    with open(os.path.join(DATA, "termino.geojson"), "w") as f:
        json.dump({"type": "Feature", "properties": {"nombre": "Marbella"},
                   "geometry": mapping(termino.simplify(0.0002))}, f, separators=(",", ":"))
    resumen = {"red": construir_red(osm, zona, Relieve()),
               "edificios": construir_edificios(),
               "vegetacion": construir_vegetacion(osm, zona),
               "buscador": construir_buscador(osm, zona)}
    meta = {"lon0": LON0, "lat0": LAT0, "kx": KX, "ky": KY,
            "generado": date.today().isoformat(), "fecha_osm": osm.get("fecha_osm"),
            "bbox": [b for b in termino.bounds],
            "fuentes": {"red": "OpenStreetMap (© colaboradores de OpenStreetMap, ODbL)",
                        "edificios": "Dirección General del Catastro (INSPIRE Buildings, 29069 Marbella)",
                        "vegetacion": "OpenStreetMap (natural=tree, tree_row, wood; landuse=forest)",
                        "relieve": "Gemelo Digital de Marbella (Terrain Tiles / EMODnet)"},
            "supuestos": {"altura": f"{H_PLANTA:g} m por planta + {H_EXTRA:g} m", "margen_termino_m": MARGEN_TERMINO},
            "totales": resumen}
    with open(os.path.join(DATA, "meta.json"), "w", encoding="utf8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(json.dumps(resumen, ensure_ascii=False))
    if resumen["edificios"]["cuerpos"] < 30000 or resumen["red"]["tramos"] < 10000:
        sys.exit("Muy pocos datos: algo ha fallado")


if __name__ == "__main__":
    main()
