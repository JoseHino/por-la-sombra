// Worker del motor: carga los datos una vez y calcula rutas y sombras sin bloquear el mapa.
import { leerPLS, Plano, Proyectores, Sombras, Red, Rutero, posicionSol, vectorSombra, imagenSombras } from './motor.js';

let plano, proy, sombras, red, rutero, meta, listo = null;

async function bajar(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se ha podido descargar ${url.split('/').pop()} (HTTP ${r.status})`);
  let buf = await r.arrayBuffer();
  const u8 = new Uint8Array(buf, 0, 2);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {          // .gz servido tal cual: se descomprime aquí
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return buf;
}

async function iniciar(base) {
  meta = await (await fetch(base + 'data/meta.json', { cache: 'no-cache' })).json();
  const v = encodeURIComponent(meta.generado);
  const [r, e, g] = await Promise.all(['red', 'edificios', 'vegetacion'].map(n => bajar(`${base}data/${n}.bin.gz?v=${v}`)));
  plano = new Plano(meta);
  red = new Red(leerPLS(r), plano);
  proy = new Proyectores(leerPLS(e), leerPLS(g));
  sombras = new Sombras(proy, plano);
  rutero = new Rutero(red, sombras);
  return { tramos: red.E, cruces: red.N, proyectores: proy.n, edificios: proy.nEdificios, generado: meta.generado };
}

function sombrasVista({ bbox, ms, maxPx }) {
  const [w, s, e, n] = bbox;
  const [x0, y0] = plano.xy(w, s), [x1, y1] = plano.xy(e, n);
  const [lon, lat] = plano.ll((x0 + x1) / 2, (y0 + y1) / 2);
  const sol = posicionSol(new Date(ms), lat, lon), vs = vectorSombra(sol);
  if (!vs.haySol) return { sol, vacia: true };
  const img = imagenSombras(proy, x0, y0, x1, y1, maxPx, vs);
  const [E, N] = plano.ll(x0 + img.W * img.res, y0 + img.H * img.res);
  return { sol, W: img.W, H: img.H, rgba: img.rgba, esquinas: [[w, N], [E, N], [E, s], [w, s]] };
}

onmessage = async ({ data: m }) => {
  const responde = (r, transfer) => postMessage({ id: m.id, ok: true, r }, transfer || []);
  try {
    if (m.tipo === 'iniciar') {
      listo = iniciar(m.base);
      responde(await listo);
      return;
    }
    if (!listo) throw new Error('El motor no se ha iniciado');
    await listo;
    if (m.tipo === 'ruta') {
      const t0 = performance.now();
      const r = rutero.rutas(m.origen, m.destino, m.salida, m.opc);
      r.ms = Math.round(performance.now() - t0);
      if (sombras.franjas.size > 30) sombras.liberar();
      responde(r);
    } else if (m.tipo === 'sombras') {
      const r = sombrasVista(m);
      responde(r, r.rgba ? [r.rgba.buffer] : []);
    } else if (m.tipo === 'cercano') {
      const [x, y] = plano.xy(...m.punto);
      const c = red.cercano(x, y, m.radio || 300);
      responde(c ? { d: c.d, punto: plano.ll(c.px, c.py), nombre: red.nombres[red.nom[c.e]] || '' } : null);
    } else {
      throw new Error('Mensaje desconocido: ' + m.tipo);
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
