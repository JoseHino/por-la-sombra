// Indicadores del Observatorio de la sombra (observatorio/data/data.js), con el mismo motor que la app.
//
// Para el día 15 de cada mes y cada hora en punto con sol (hora de Marbella), mide qué parte de cada
// tramo de la red peatonal queda a la sombra: en las calles con acera, la mejor de las dos aceras (la
// que elegiría quien busca la sombra). Agrega por toda la red, por zonas (los núcleos y zonas de
// OpenStreetMap) y por calles. Va tesela a tesela (256 m) para no guardar en memoria todas las
// sombras, y reparte las teselas entre varios hilos.
//
// Uso: node scripts/indicadores.mjs   (≈ 2-4 min con 6 hilos; HILOS=2 para gastar menos memoria)

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { cpus } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

const BASE = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(pathToFileURL(join(BASE, 'js', 'motor.js')));
const ANIO = 2026, PASO = 4, MARGEN = 24;
const HORAS = Array.from({ length: 15 }, (_, i) => 7 + i);          // 7:00 … 21:00
const MESES = Array.from({ length: 12 }, (_, i) => i + 1);

function cargar() {
  const meta = JSON.parse(readFileSync(join(BASE, 'data', 'meta.json'), 'utf8'));
  const ab = n => { const b = gunzipSync(readFileSync(join(BASE, 'data', n))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const plano = new M.Plano(meta);
  const red = new M.Red(M.leerPLS(ab('red.bin.gz')), plano);
  const proy = new M.Proyectores(M.leerPLS(ab('edificios.bin.gz')), M.leerPLS(ab('vegetacion.bin.gz')));
  return { meta, plano, red, proy };
}

// instantes: [mes, hora, ms, vector de sombra]
function instantes(plano) {
  const [lon, lat] = plano.ll(0, 0), out = [];
  for (const m of MESES) for (const h of HORAS) {
    const ms = M.fechaMadrid(ANIO, m, 15, h, 0).valueOf();
    const sol = M.posicionSol(new Date(ms), lat, lon);
    out.push({ m, h, ms, alt: sol.altG, vs: M.vectorSombra(sol) });
  }
  return out;
}

// muestras de la red: cada PASO metros, en el centro y en cada acera posible
function muestras(red) {
  const S = [];       // [e, lado, peso, x, y, nx, ny, off]
  for (let e = 0; e < red.E; e++) {
    const fl = red.flags[e];
    const lados = [];
    if (fl & M.F.CENTRO || !(fl & (M.F.IZQ | M.F.DER))) lados.push(0);
    if (fl & M.F.IZQ) lados.push(1);
    if (fl & M.F.DER) lados.push(-1);
    for (let q = red.gi[e]; q < red.gi[e + 1] - 1; q++) {
      const ax = red.gx[q], ay = red.gy[q], bx = red.gx[q + 1], by = red.gy[q + 1];
      const ls = Math.hypot(bx - ax, by - ay);
      if (ls < 1e-6) continue;
      const n = Math.max(1, Math.ceil(ls / PASO)), w = ls / n, nx = -(by - ay) / ls, ny = (bx - ax) / ls;
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        for (const l of lados) S.push([e, l, w, ax + u * (bx - ax), ay + u * (by - ay), nx, ny, red.off[e]]);
      }
    }
  }
  return S;
}

// --------------------------------------------------------------------------- hilo de trabajo
if (!isMainThread) {
  const { red, proy } = cargar();
  const inst = workerData.instantes;
  const T = M.TESELA, W = T + 2 * MARGEN;
  const acc = new Float64Array(inst.length * red.E * 3);
  const mascara = new Uint8Array(W * W), sombra = new Uint8Array(W * W);
  for (const { i, j, ms } of workerData.teselas) {
    const x0 = i * T - MARGEN, y0 = j * T - MARGEN;
    mascara.fill(0);
    proy.rasterizar(mascara, x0, y0, W, W, 1, null, true);
    const dentro = (x, y) => { const c = Math.floor(x - x0), r = Math.floor(y - y0); return c >= 0 && r >= 0 && c < W && r < W && mascara[r * W + c] === 1; };
    // posición final de cada muestra (si la acera cae dentro de un edificio, se acerca al eje)
    const n = ms.length, pix = new Int32Array(n), dst = new Int32Array(n), peso = new Float32Array(n), cub = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const [e, l, w, x, y, nx, ny, off] = ms[k];
      let qx = x, qy = y;
      if (l !== 0) {
        qx = x + l * off * nx; qy = y + l * off * ny;
        if (dentro(qx, qy)) { qx = x + l * off * 0.5 * nx; qy = y + l * off * 0.5 * ny; if (dentro(qx, qy)) { qx = x; qy = y; } }
      }
      const c = Math.min(W - 1, Math.max(0, Math.floor(qx - x0))), r = Math.min(W - 1, Math.max(0, Math.floor(qy - y0)));
      pix[k] = r * W + c; dst[k] = e * 3 + l + 1; peso[k] = w; cub[k] = red.flags[e] & M.F.CUBIERTO ? 1 : 0;
    }
    for (let a = 0; a < inst.length; a++) {
      const vs = inst[a].vs, base = a * red.E * 3;
      if (!vs.haySol) { for (let k = 0; k < n; k++) acc[base + dst[k]] += peso[k]; continue; }
      sombra.fill(0);
      proy.rasterizar(sombra, x0, y0, W, W, 1, vs);
      for (let k = 0; k < n; k++) acc[base + dst[k]] += peso[k] * (cub[k] ? 255 : sombra[pix[k]]) / 255;
    }
    parentPort.postMessage({ hecha: 1 });
  }
  parentPort.postMessage({ acc }, [acc.buffer]);
}

// --------------------------------------------------------------------------- hilo principal
else {
  const t0 = Date.now();
  const { meta, plano, red, proy } = cargar();
  const inst = instantes(plano);
  const S = muestras(red);
  // longitud medida de cada tramo y lado
  const lon = new Float64Array(red.E * 3);
  for (const [e, l, w] of S) lon[e * 3 + l + 1] += w;
  // reparto por teselas
  const teselas = new Map();
  for (const s of S) {
    const i = Math.floor(s[3] / M.TESELA), j = Math.floor(s[4] / M.TESELA), k = i * 100000 + j;
    if (!teselas.has(k)) teselas.set(k, { i, j, ms: [] });
    teselas.get(k).ms.push(s);
  }
  const lista = [...teselas.values()].sort((a, b) => b.ms.length - a.ms.length);
  const nH = Math.max(1, +process.env.HILOS || Math.min(8, cpus().length - 2));
  console.log(`Red: ${red.E} tramos, ${S.length} muestras en ${lista.length} teselas; ${inst.length} instantes; ${nH} hilos`);
  const lotes = Array.from({ length: nH }, () => []);
  lista.forEach((t, k) => lotes[k % nH].push(t));
  const instPlano = inst.map(({ m, h, ms, alt, vs }) => ({ m, h, ms, alt, vs }));
  let hechas = 0;
  const parciales = await Promise.all(lotes.map(lote => new Promise((ok, ko) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { teselas: lote, instantes: instPlano } });
    w.on('message', m => {
      if (m.hecha) { if (++hechas % 200 === 0) console.log(`  ${hechas}/${lista.length} teselas (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
      else ok(m.acc);
    });
    w.on('error', ko);
  })));
  const acc = new Float64Array(inst.length * red.E * 3);
  for (const p of parciales) for (let k = 0; k < acc.length; k++) acc[k] += p[k];

  // fracción a la sombra de cada tramo e instante (la mejor de sus lados)
  const frac = (a, e) => {
    let mejor = 0;
    for (let l = 0; l < 3; l++) { const L = lon[e * 3 + l]; if (L > 0) mejor = Math.max(mejor, acc[(a * red.E + e) * 3 + l] / L); }
    return mejor;
  };
  const len = e => Math.max(lon[e * 3], lon[e * 3 + 1], lon[e * 3 + 2]);

  // zonas: el núcleo o la zona de OpenStreetMap más cercana al centro del tramo
  const busc = JSON.parse(readFileSync(join(BASE, 'data', 'buscador.json'), 'utf8')).items;
  const semillas = busc.filter(x => ['Ciudad', 'Núcleo', 'Zona'].includes(x[1])).map(x => ({ nombre: x[0], x: x[2] / 10, y: x[3] / 10 }));
  const zonaDe = new Int32Array(red.E);
  for (let e = 0; e < red.E; e++) {
    const g = Math.floor((red.gi[e] + red.gi[e + 1] - 1) / 2), x = red.gx[g], y = red.gy[g];
    let mejor = -1, d = 2500;
    semillas.forEach((s, k) => { const dd = Math.hypot(s.x - x, s.y - y); if (dd < d) { d = dd; mejor = k; } });
    zonaDe[e] = mejor;
  }

  const idx = (m, h) => inst.findIndex(t => t.m === m && t.h === h);
  const agrega = filtro => {
    const out = MESES.map(() => HORAS.map(() => null));
    inst.forEach((t, a) => {
      if (t.alt < 2) return;
      let s = 0, L = 0;
      for (let e = 0; e < red.E; e++) if (filtro(e)) { const l = len(e); s += l * frac(a, e); L += l; }
      out[t.m - 1][HORAS.indexOf(t.h)] = L > 0 ? Math.round(1000 * s / L) / 10 : null;
    });
    return out;
  };
  const todo = agrega(() => true);
  // zonas con al menos 15 km de red
  const kmZona = new Map();
  for (let e = 0; e < red.E; e++) if (zonaDe[e] >= 0) kmZona.set(zonaDe[e], (kmZona.get(zonaDe[e]) || 0) + len(e) / 1000);
  const zonas = [...kmZona.entries()].filter(([, km]) => km >= 15).sort((a, b) => b[1] - a[1])
    .map(([k, km]) => ({ nombre: semillas[k].nombre, km: Math.round(km), pct: agrega(e => zonaDe[e] === k) }));
  // calles con nombre y al menos 300 m: % a la sombra en tres momentos de julio
  const porCalle = new Map();
  for (let e = 0; e < red.E; e++) {
    const n = red.nombres[red.nom[e]];
    if (!n || red.cls[e] === 0) continue;
    const k = n + '|' + zonaDe[e];
    if (!porCalle.has(k)) porCalle.set(k, { nombre: n, zona: semillas[zonaDe[e]]?.nombre || '', tramos: [] });
    porCalle.get(k).tramos.push(e);
  }
  const momentos = { 'jul_12': idx(7, 12), 'jul_15': idx(7, 15), 'jul_18': idx(7, 18), 'ene_13': idx(1, 13) };
  const calles = [];
  for (const c of porCalle.values()) {
    const m = c.tramos.reduce((a, e) => a + len(e), 0);
    if (m < 300) continue;
    const fila = { nombre: c.nombre, zona: c.zona, m: Math.round(m) };
    for (const [clave, a] of Object.entries(momentos)) fila[clave] = Math.round(100 * c.tramos.reduce((s, e) => s + len(e) * frac(a, e), 0) / m);
    calles.push(fila);
  }
  calles.sort((a, b) => b.m - a.m);
  // horas de sol directo en un metro medio de acera (del amanecer al anochecer, día 15)
  const horasSol = MESES.map(m => {
    let h = 0;
    inst.filter(t => t.m === m && t.alt >= 2).forEach(t => { h += 1 - todo[m - 1][HORAS.indexOf(t.h)] / 100; });
    return Math.round(h * 10) / 10;
  });
  const solAlt = MESES.map(m => HORAS.map(h => Math.round(inst[idx(m, h)].alt * 10) / 10));

  const tot = meta.totales;
  const datos = {
    meta: { generado: new Date().toISOString(), datos: meta.generado, fecha_osm: meta.fecha_osm, anio: ANIO,
            km_red: Math.round([...Array(red.E).keys()].reduce((a, e) => a + len(e), 0) / 1000), tramos: red.E,
            edificios: tot.edificios.cuerpos, arboles: tot.vegetacion.arboles + tot.vegetacion.arboles_hileras,
            masas: tot.vegetacion.masas, km_aceras: tot.red.km_calzada_con_aceras },
    horas: HORAS, meses: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
    red: todo, sol_alt: solAlt, horas_sol: horasSol, zonas, calles,
  };
  // nunca se publica un panel peor que el vigente: si la red sale recortada, se aborta
  if (datos.meta.km_red < 1000 || zonas.length < 5 || calles.length < 100) {
    console.error('Indicadores incompletos: no se escribe data.js', datos.meta.km_red, zonas.length, calles.length);
    process.exit(1);
  }
  mkdirSync(join(BASE, 'observatorio', 'data'), { recursive: true });
  writeFileSync(join(BASE, 'observatorio', 'data', 'data.js'),
    '// Lo escribe scripts/indicadores.mjs; no se edita a mano.\nwindow.DATOS = ' + JSON.stringify(datos) + ';\n');
  console.log(`Hecho en ${((Date.now() - t0) / 1000).toFixed(0)} s: julio a las 15 h, ${todo[6][HORAS.indexOf(15)]} % de la red a la sombra; ` +
              `${zonas.length} zonas, ${calles.length} calles`);
}
