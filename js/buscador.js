// Buscador: índice propio (calles, zonas y lugares de OpenStreetMap, data/buscador.json) y, para
// direcciones con número, el geocodificador oficial CartoCiudad (IGN); Photon como último recurso.

let items = [], meta = null;
const CORTOS = { 'c': 'calle', 'cl': 'calle', 'cll': 'calle', 'av': 'avenida', 'avd': 'avenida', 'avda': 'avenida',
                 'pza': 'plaza', 'pl': 'plaza', 'plz': 'plaza', 'urb': 'urbanizacion', 'ctra': 'carretera',
                 'po': 'paseo', 'pº': 'paseo', 'pso': 'paseo', 'bda': 'barriada', 'pje': 'pasaje', 'gta': 'glorieta', 'sta': 'santa', 'sto': 'santo' };
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'a', 'en']);
const PESO = { 'Calle': 1.15, 'Playa': 1.3, 'Zona': 1.25, 'Núcleo': 1.25, 'Barrio': 1.15, 'Hospital': 1.2, 'Centro de salud': 1.15,
               'Parada de autobús': 0.75, 'Aparcamiento': 0.8, 'Lugar de interés': 1.1, 'Monumento': 1.1, 'Plaza': 1.15, 'Museo': 1.1 };

export const normal = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/c\//g, 'calle ').replace(/[^a-z0-9ñº ]+/g, ' ').replace(/\s+/g, ' ').trim();
const fichas = s => normal(s).split(' ').map(t => CORTOS[t] || t).filter(t => t && !VACIAS.has(t));

export async function cargar(base, m) {
  meta = m;
  const j = await (await fetch(base + 'data/buscador.json?v=' + encodeURIComponent(m.generado))).json();
  items = j.items.map(([nombre, cat, x, y, ctx]) => ({
    nombre, cat, ctx, lon: m.lon0 + x / 10 / m.kx, lat: m.lat0 + y / 10 / m.ky, f: fichas(nombre), fc: fichas(ctx),
  }));
  return items.length;
}

const dist = (a, b) => Math.hypot((a[0] - b[0]) * 89590, (a[1] - b[1]) * 110968);

// resultados del índice propio, ordenados por coincidencia, tipo y cercanía al punto de referencia
export function buscarLocal(q, ref, n = 8) {
  const qf = fichas(q);
  if (!qf.length) return [];
  const res = [];
  for (const it of items) {
    let s = 0, ok = true;
    for (const t of qf) {
      let m = 0;
      for (const f of it.f) {
        if (f === t) { m = 3; break; }
        if (f.startsWith(t)) m = Math.max(m, 2);
        else if (t.length >= 4 && f.includes(t)) m = Math.max(m, 1);
      }
      if (!m) for (const f of it.fc) if (f.startsWith(t)) { m = 0.8; break; }
      if (!m) { ok = false; break; }
      s += m;
    }
    if (!ok) continue;
    if (it.f[0] && it.f[0].startsWith(qf[0])) s += 1;
    if (it.f.length === qf.length) s += 0.5;
    s *= PESO[it.cat] || 1;
    if (ref) s += 1.5 / (1 + dist(ref, [it.lon, it.lat]) / 2000);
    res.push([s, it]);
  }
  res.sort((a, b) => b[0] - a[0]);
  return res.slice(0, n).map(([, it]) => ({ texto: it.nombre, sub: [it.cat, it.ctx].filter(Boolean).join(' · '), lon: it.lon, lat: it.lat, cat: it.cat }));
}

// direcciones con número: CartoCiudad (portales y topónimos del municipio)
export async function buscarDirecciones(q, señal) {
  const url = `https://www.cartociudad.es/geocoder/api/geocoder/candidates?q=${encodeURIComponent(q)}&limit=8&municipio_filter=Marbella`;
  try {
    const r = await fetch(url, { signal: señal });
    if (!r.ok) throw new Error(r.status);
    const l = await r.json();
    const out = l.filter(c => c.lat && c.lng && c.muniCode === '29069')
      .map(c => ({ texto: titulo(c.address.replace(/, Marbella$/, '').replace(/\s*\(Marbella\)$/, '')), sub: c.type === 'portal' ? `Dirección · ${c.poblacion || 'Marbella'}` : 'Lugar · CartoCiudad', lon: c.lng, lat: c.lat, cat: 'Dirección' }));
    if (out.length) return out;
  } catch (e) { if (e.name === 'AbortError') throw e; }
  // último recurso: Photon (OpenStreetMap), limitado a la zona de Marbella
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&bbox=-5.08,36.44,-4.72,36.60&lat=36.51&lon=-4.88`, { signal: señal });
    const j = await r.json();
    return j.features.map(f => ({ texto: [f.properties.name || f.properties.street, f.properties.housenumber].filter(Boolean).join(' '),
      sub: [f.properties.street && f.properties.name ? f.properties.street : null, f.properties.city || f.properties.district].filter(Boolean).join(' · ') || 'OpenStreetMap',
      lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], cat: 'Dirección' })).filter(x => x.texto);
  } catch (e) { if (e.name === 'AbortError') throw e; return []; }
}

const titulo = s => s.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Del|La|Las|El|Los|Y)\b/g, w => w.toLowerCase());
