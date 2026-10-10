"""
Extrae de un fichero PBF de OpenStreetMap (Geofabrik, Andalucía) lo que la app necesita del
municipio de Marbella y lo guarda en build/osm.pkl, para no volver a leer los ~200 MB del PBF:

  - vías por las que se puede andar (con su geometría y etiquetas),
  - árboles sueltos, hileras de árboles y masas arboladas,
  - lugares (barrios, urbanizaciones) y puntos de interés con nombre, para el buscador,
  - el término municipal.

Va en dos pasadas para no llenar la memoria: primero las relaciones (multipolígonos y el término)
y luego nodos y vías con la caché de coordenadas de osmium. Ensamblar áreas de toda Andalucía con
with_areas() se comía más de 5 GB.

Uso: python scripts/extraer_osm.py [ruta.pbf]
Sin ruta, descarga el extracto de Andalucía de Geofabrik a build/andalucia.osm.pbf.
"""

import os, pickle, sys, time, urllib.request

import osmium
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import linemerge, polygonize, unary_union

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("CACHE_DIR", os.path.join(BASE, "build"))
URL_PBF = "https://download.geofabrik.de/europe/spain/andalucia-latest.osm.pbf"
BBOX = (36.44, -5.08, 36.60, -4.72)        # sur, oeste, norte, este: el término municipal con margen

# claves que hacen interesante un nodo o un área para el buscador
CLAVES_POI = ("amenity", "shop", "tourism", "leisure", "historic", "healthcare", "office", "craft",
              "sport", "public_transport", "railway", "aeroway", "club", "place", "man_made")


def en_caja(lon, lat):
    S, W, N, E = BBOX
    return S <= lat <= N and W <= lon <= E


def es_arbolado(tg):
    return tg.get("natural") == "wood" or tg.get("landuse") == "forest"


def interesa_area(tg):
    """Multipolígonos que hay que montar: arbolado, el término y áreas con nombre para el buscador."""
    if es_arbolado(tg):
        return True
    if tg.get("boundary") == "administrative" and tg.get("admin_level") == "8":
        return True
    return "name" in tg and (any(k in tg for k in CLAVES_POI) or tg.get("natural") in ("beach", "bay", "cape")
                             or tg.get("highway") == "pedestrian" or tg.get("place"))


def etiquetas(o):
    return {t.k: t.v for t in o.tags}


def montar(miembros, lineas):
    """Polígonos de una relación a partir de las líneas de sus vías (outer / inner)."""
    def poligonos(rol):
        ls = [LineString(lineas[w]) for w, r in miembros if r == rol and w in lineas and len(lineas[w]) >= 2]
        if not ls:
            return []
        return [p for p in polygonize(linemerge(ls)) if p.is_valid and p.area > 0]
    ext, inn = poligonos("outer") or poligonos(""), poligonos("inner")
    if not ext:
        return None
    g = unary_union(ext)
    if inn:
        g = g.difference(unary_union(inn))
    return g if not g.is_empty else None


def a_anillos(g):
    """Geometría shapely -> [(anillo exterior, [huecos])] en lon/lat."""
    polys = [g] if isinstance(g, Polygon) else list(g.geoms) if isinstance(g, MultiPolygon) else []
    return [(list(p.exterior.coords), [list(i.coords) for i in p.interiors]) for p in polys]


def main():
    pbf = sys.argv[1] if len(sys.argv) > 1 else os.path.join(CACHE, "andalucia.osm.pbf")
    if not os.path.exists(pbf):
        os.makedirs(CACHE, exist_ok=True)
        print("Descargando el extracto de Andalucía (Geofabrik)...", flush=True)
        urllib.request.urlretrieve(URL_PBF, pbf)
    t0 = time.time()

    # ---- pasada 1: relaciones (solo ids de sus vías)
    relaciones = {}
    for r in osmium.FileProcessor(pbf, osmium.osm.RELATION).with_filter(osmium.filter.KeyFilter("type")):
        tg = etiquetas(r)
        if tg.get("type") not in ("multipolygon", "boundary") or not interesa_area(tg):
            continue
        miembros = [(m.ref, m.role) for m in r.members if m.type == "w"]
        if miembros:
            relaciones[r.id] = (tg, miembros)
    vias_rel = {w for _, ms in relaciones.values() for w, _ in ms}
    print(f"Relaciones candidatas: {len(relaciones)} ({len(vias_rel)} vías) ({time.time() - t0:.0f} s)", flush=True)

    # ---- pasada 2: nodos con etiquetas y vías, con la caché de coordenadas
    vias, nodos, areas_via, hileras, lineas = [], [], [], [], {}
    n = 0
    fp = osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations()
    for o in fp:
        n += 1
        if n % 5_000_000 == 0:
            print(f"  {n // 1_000_000} M objetos ({time.time() - t0:.0f} s)", flush=True)
        if o.is_node():
            if not len(o.tags):
                continue
            lon, lat = o.location.lon, o.location.lat
            if not en_caja(lon, lat):
                continue
            tg = etiquetas(o)
            if tg.get("natural") == "tree" or any(k in tg for k in CLAVES_POI) or tg.get("natural") in ("beach", "peak", "cape") \
                    or tg.get("highway") == "bus_stop" or "name" in tg and tg.get("highway") is None and tg.get("place"):
                nodos.append((o.id, lon, lat, tg))
            continue
        # vía
        es_rel = o.id in vias_rel
        if not len(o.tags) and not es_rel:
            continue
        try:
            coords = [(r.lon, r.lat) for r in o.nodes]
        except osmium.InvalidLocationError:
            coords = [(r.lon, r.lat) for r in o.nodes if r.location.valid()]
        if len(coords) < 2 or not any(en_caja(*c) for c in coords[:: max(1, len(coords) // 8)] + [coords[-1]]):
            continue
        if es_rel:
            lineas[o.id] = coords
        if not len(o.tags):
            continue
        tg = etiquetas(o)
        if "highway" in tg:
            vias.append((o.id, [r.ref for r in o.nodes], coords, tg))
        if tg.get("natural") == "tree_row":
            hileras.append((o.id, coords, tg))
        if coords[0] == coords[-1] and len(coords) >= 4 and interesa_area(tg) and tg.get("area") != "no" \
                and (tg.get("highway") is None or tg.get("area") == "yes"):
            areas_via.append(("w" + str(o.id), [(coords, [])], tg))
    print(f"Vías con highway: {len(vias)} | nodos con etiquetas: {len(nodos)} | áreas cerradas: {len(areas_via)} | "
          f"hileras: {len(hileras)} ({time.time() - t0:.0f} s)", flush=True)

    # ---- multipolígonos que caen en la caja
    areas, termino = list(areas_via), None
    for rid, (tg, miembros) in relaciones.items():
        if not any(w in lineas for w, _ in miembros):
            continue
        g = montar(miembros, lineas)
        if g is None:
            continue
        anillos = a_anillos(g)
        if tg.get("boundary") == "administrative":
            if tg.get("name") == "Marbella":
                termino = anillos
            continue
        areas.append(("r" + str(rid), anillos, tg))
    print(f"Áreas (con multipolígonos): {len(areas)} | término municipal: {'sí' if termino else 'NO'}")

    fecha = None
    try:
        h = osmium.io.Reader(pbf, osmium.osm.osm_entity_bits.NOTHING).header()
        fecha = h.get("osmosis_replication_timestamp") or h.get("timestamp")
    except Exception:
        pass
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "osm.pkl"), "wb") as f:
        pickle.dump({"vias": vias, "nodos": nodos, "areas": areas, "hileras": hileras,
                     "termino": termino, "fecha_osm": fecha, "bbox": BBOX}, f)
    print(f"Guardado {os.path.join(CACHE, 'osm.pkl')} | datos OSM de {fecha} | {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
