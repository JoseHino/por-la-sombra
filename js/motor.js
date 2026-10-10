// Por la sombra · motor de sol, sombras y rutas a pie.
// Sin DOM: lo usan el worker del navegador (js/worker.js) y los scripts de Node (scripts/indicadores.mjs).
//
// Coordenadas: metros en un plano local (x al este, y al norte) alrededor de (lon0, lat0), que
// vienen en data/meta.json. En el término de Marbella el error de esta aproximación es del orden
// de 1 m por km.
//
// Sombras: cada cuerpo de edificio del Catastro es un prisma (huella × altura) y cada árbol, un
// prisma "flotante" entre la base de la copa y la copa. La sombra de un prisma es la suma de
// Minkowski de su huella con el segmento que recorre la sombra de su base a la de su techo; se
// rasteriza a 1 m en teselas de 256 m (unión de la huella desplazada y de los cuadriláteros de las
// aristas que miran hacia donde se proyecta la sombra). No tiene en cuenta el relieve.
//
// Rutas: A* sobre la red peatonal de OpenStreetMap con coste = metros a la sombra + (1 + β) ×
// metros al sol. La sombra de cada tramo se mide en el centro y, en las calles con acera, en las
// dos aceras, y se queda con la mejor; se calcula con el sol de la hora a la que se llega a ese
// tramo (franjas de 10 minutos).

export const RAD = Math.PI / 180;
const DIA_J = 86400000, J1970 = 2440588, J2000 = 2451545, OBLICUIDAD = 23.4397 * RAD;

export const TESELA = 256;         // m (y píxeles: la sombra se rasteriza a 1 m)
export const FRANJA = 600;         // s: el sol se recalcula cada 10 minutos de camino
export const ALT_MIN = 2 * RAD;    // por debajo, sin sol directo
export const SOMBRA_MAX = 500;     // m: tope de la longitud de una sombra (sol muy bajo)
const PASO = 2;                    // m entre muestras al medir la sombra de un tramo
const CELDA = 100;                 // m: rejillas de búsqueda

// banderas de los tramos (data/red.bin): las mismas que escribe scripts/construir_datos.py
export const F = { ESCALERA: 1, CUBIERTO: 2, IZQ: 4, DER: 8, CENTRO: 16, ACERA_APARTE: 32, PUENTE: 64, CRUCE: 128 };

// ------------------------------------------------------------------ sol (fórmulas de SunCalc)
export function posicionSol(fecha, lat, lon) {
  const d = fecha.valueOf() / DIA_J - 0.5 + J1970 - J2000;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLICUIDAD) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBLICUIDAD), Math.cos(L));
  const H = RAD * (280.16 + 360.9856235 * d) - RAD * -lon - ra, phi = RAD * lat;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)); // desde el sur, + al oeste
  const az = ((azS / RAD + 180) % 360 + 360) % 360;                                                // desde el norte, + al este
  return { alt, az, altG: alt / RAD };
}

// sombra que proyecta cada metro de altura (vector en el plano) y si hay sol directo
export function vectorSombra(sol) {
  if (sol.alt < ALT_MIN) return { haySol: false, vx: 0, vy: 0, largo: Infinity };
  const largo = 1 / Math.tan(sol.alt), a = sol.az * RAD;
  return { haySol: true, vx: -Math.sin(a) * largo, vy: -Math.cos(a) * largo, largo };
}

// hora de Madrid -> Date, con el horario de verano de ese día
export function fechaMadrid(anio, mes, dia, hora, minuto = 0) {
  const base = Date.UTC(anio, mes - 1, dia, hora, minuto);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(base)).map(x => [x.type, x.value]));
  const off = +(p.timeZoneName.match(/GMT([+-]\d+)/)?.[1] || 1);
  return new Date(base - off * 3600000);
}

// ------------------------------------------------------------------ contenedor binario PLS1
// 'PLS1' · uint32 longitud de la cabecera · cabecera JSON · arrays alineados a 4 bytes
const TIPOS = { int32: Int32Array, uint32: Uint32Array, int16: Int16Array, uint16: Uint16Array,
                uint8: Uint8Array, int8: Int8Array, float32: Float32Array };
export function leerPLS(buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'PLS1') throw new Error('Formato de datos desconocido');
  const lc = new DataView(buf).getUint32(4, true);
  const cab = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + lc)));
  const base = 8 + lc + ((4 - (lc % 4)) % 4), arr = {};
  for (const a of cab.arrays) arr[a.name] = new TIPOS[a.type](buf, base + a.offset, a.length);
  return { cab, arr };
}

// ------------------------------------------------------------------ geometría auxiliar
export class Plano {
  constructor(meta) { Object.assign(this, { lon0: meta.lon0, lat0: meta.lat0, kx: meta.kx, ky: meta.ky }); }
  xy(lon, lat) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }
  ll(x, y) { return [this.lon0 + x / this.kx, this.lat0 + y / this.ky]; }
}

// rejilla CSR: celda -> lista de elementos cuya caja la toca
function rejilla(n, caja, x0, y0, nx, ny) {
  const cuenta = new Uint32Array(nx * ny + 1);
  const recorre = (i, f) => {
    const c0 = Math.max(0, Math.floor((caja[4 * i] - x0) / CELDA)), c1 = Math.min(nx - 1, Math.floor((caja[4 * i + 2] - x0) / CELDA));
    const r0 = Math.max(0, Math.floor((caja[4 * i + 1] - y0) / CELDA)), r1 = Math.min(ny - 1, Math.floor((caja[4 * i + 3] - y0) / CELDA));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) f(r * nx + c);
  };
  for (let i = 0; i < n; i++) recorre(i, k => cuenta[k + 1]++);
  for (let k = 0; k < nx * ny; k++) cuenta[k + 1] += cuenta[k];
  const items = new Uint32Array(cuenta[nx * ny]), pos = cuenta.slice(0, nx * ny);
  for (let i = 0; i < n; i++) recorre(i, k => { items[pos[k]++] = i; });
  return { ini: cuenta, items, x0, y0, nx, ny };
}

// ------------------------------------------------------------------ relleno de polígonos (scanline)
// Pinta con max(valor) los píxeles cuyo centro cae dentro del polígono (xs, ys en píxeles).
let cortes = new Float64Array(64);
function rellenar(buf, W, H, xs, ys, n, val) {
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) { const y = ys[i]; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const r0 = Math.max(0, Math.ceil(ymin - 0.5)), r1 = Math.min(H - 1, Math.ceil(ymax - 0.5) - 1);
  if (r1 < r0) return;
  if (cortes.length < n) cortes = new Float64Array(n * 2);
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5;
    let k = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ys[i], yj = ys[j];
      if ((yi <= yc) !== (yj <= yc)) cortes[k++] = xs[i] + (yc - yi) / (yj - yi) * (xs[j] - xs[i]);
    }
    for (let a = 1; a < k; a++) {            // inserción: k casi siempre es 2
      const v = cortes[a]; let b = a - 1;
      while (b >= 0 && cortes[b] > v) { cortes[b + 1] = cortes[b]; b--; }
      cortes[b + 1] = v;
    }
    const fila = r * W;
    for (let m = 0; m + 1 < k; m += 2) {
      const c0 = Math.max(0, Math.ceil(cortes[m] - 0.5)), c1 = Math.min(W - 1, Math.ceil(cortes[m + 1] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) if (buf[fila + c] < val) buf[fila + c] = val;
    }
  }
}

// ------------------------------------------------------------------ proyectores de sombra
// Edificios (prismas desde el suelo) y vegetación (prismas entre la base de la copa y la copa).
export class Proyectores {
  constructor(edificios, vegetacion) {
    const partes = [];          // [verticesX, verticesY, base, techo, valor, esEdificio]
    const E = edificios.arr, cabE = edificios.cab;
    let nv = 0;
    const nE = E.h.length, nArb = vegetacion ? vegetacion.arr.tx.length : 0, nBos = vegetacion ? vegetacion.arr.bh.length : 0;
    let totalV = 0;
    for (let i = 0; i < nE; i++) totalV += E.nv[i];
    if (vegetacion) totalV += nArb * 8 + vegetacion.arr.bnv.reduce((a, b) => a + b, 0);
    const n = nE + nArb + nBos;
    this.n = n; this.nEdificios = nE;
    this.vx = new Float32Array(totalV); this.vy = new Float32Array(totalV);
    this.ini = new Uint32Array(n); this.num = new Uint32Array(n);
    this.base = new Float32Array(n); this.techo = new Float32Array(n); this.valor = new Uint8Array(n);
    this.ccw = new Uint8Array(n); this.caja = new Float32Array(4 * n);
    let v = 0;
    const cierra = (i, v0) => {           // orientación y caja del anillo i
      let area = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      const m = v - v0;
      for (let a = v0, b = v - 1; a < v; b = a++) {
        area += this.vx[b] * this.vy[a] - this.vx[a] * this.vy[b];
        if (this.vx[a] < minx) minx = this.vx[a]; if (this.vx[a] > maxx) maxx = this.vx[a];
        if (this.vy[a] < miny) miny = this.vy[a]; if (this.vy[a] > maxy) maxy = this.vy[a];
      }
      this.ini[i] = v0; this.num[i] = m; this.ccw[i] = area > 0 ? 1 : 0;
      this.caja.set([minx, miny, maxx, maxy], 4 * i);
    };
    // edificios: primer vértice absoluto (dm) y el resto como incrementos (dm)
    let d = 0;
    for (let i = 0; i < nE; i++) {
      const v0 = v;
      let x = E.x0[i], y = E.y0[i];
      this.vx[v] = x / 10; this.vy[v] = y / 10; v++;
      for (let k = 1; k < E.nv[i]; k++) {
        x += E.d[d++]; y += E.d[d++];
        this.vx[v] = x / 10; this.vy[v] = y / 10; v++;
      }
      this.base[i] = 0; this.techo[i] = E.h[i] / 10; this.valor[i] = 255;
      cierra(i, v0);
    }
    if (vegetacion) {
      const A = vegetacion.arr, cab = vegetacion.cab;
      // árboles sueltos: octógono de la copa
      for (let t = 0; t < nArb; t++) {
        const i = nE + t, v0 = v, cx = A.tx[t] / 10, cy = A.ty[t] / 10, r = A.tr[t] / 10, h = A.th[t] / 10;
        for (let k = 0; k < 8; k++) {
          const a = (k + 0.5) * Math.PI / 4;
          this.vx[v] = cx + r * Math.cos(a); this.vy[v] = cy + r * Math.sin(a); v++;
        }
        const tipo = A.tt[t];               // 0 frondoso, 1 palmera, 2 conífera
        this.base[i] = tipo === 1 ? h * 0.7 : Math.max(1.8, h * 0.3);
        this.techo[i] = h;
        this.valor[i] = tipo === 1 ? 110 : tipo === 2 ? 190 : 205;
        cierra(i, v0);
      }
      // masas arboladas (polígonos)
      let db = 0;
      for (let b = 0; b < nBos; b++) {
        const i = nE + nArb + b, v0 = v;
        let x = A.bx0[b], y = A.by0[b];
        this.vx[v] = x / 10; this.vy[v] = y / 10; v++;
        for (let k = 1; k < A.bnv[b]; k++) {
          x += A.bd[db++]; y += A.bd[db++];
          this.vx[v] = x / 10; this.vy[v] = y / 10; v++;
        }
        this.base[i] = 2; this.techo[i] = A.bh[b] / 10; this.valor[i] = 200;
        cierra(i, v0);
      }
    }
    // rejilla de búsqueda
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, hmax = 0;
    for (let i = 0; i < n; i++) {
      minx = Math.min(minx, this.caja[4 * i]); miny = Math.min(miny, this.caja[4 * i + 1]);
      maxx = Math.max(maxx, this.caja[4 * i + 2]); maxy = Math.max(maxy, this.caja[4 * i + 3]);
      hmax = Math.max(hmax, this.techo[i]);
    }
    this.hmax = hmax;
    this.rej = rejilla(n, this.caja, Math.floor(minx), Math.floor(miny),
      Math.ceil((maxx - minx + 1) / CELDA), Math.ceil((maxy - miny + 1) / CELDA));
    this.marca = new Uint32Array(n); this.sello = 0;
    this.sx = new Float64Array(64); this.sy = new Float64Array(64);
  }

  // índices de proyectores cuya caja toca [x0,x1]×[y0,y1]
  buscar(x0, y0, x1, y1, f) {
    const R = this.rej;
    const c0 = Math.max(0, Math.floor((x0 - R.x0) / CELDA)), c1 = Math.min(R.nx - 1, Math.floor((x1 - R.x0) / CELDA));
    const r0 = Math.max(0, Math.floor((y0 - R.y0) / CELDA)), r1 = Math.min(R.ny - 1, Math.floor((y1 - R.y0) / CELDA));
    if (c1 < c0 || r1 < r0) return;
    const s = ++this.sello;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * R.nx + c;
      for (let j = R.ini[k]; j < R.ini[k + 1]; j++) {
        const i = R.items[j];
        if (this.marca[i] !== s) { this.marca[i] = s; f(i); }
      }
    }
  }

  // Sombra de todos los proyectores sobre la ventana [X0, X0 + W·res) × [Y0, Y0 + H·res).
  // buf: Uint8Array(W·H), fila 0 = y mínima. Devuelve buf (0 = sol, 255 = sombra de edificio).
  rasterizar(buf, X0, Y0, W, H, res, vs, soloHuellas = false) {
    if (!soloHuellas && !vs.haySol) { buf.fill(255); return buf; }
    const X1 = X0 + W * res, Y1 = Y0 + H * res;
    let qx0 = X0, qy0 = Y0, qx1 = X1, qy1 = Y1;
    if (!soloHuellas) {                  // los proyectores que pueden alcanzar la ventana están del lado del sol
      const L = Math.min(this.hmax * vs.largo, SOMBRA_MAX), ux = -vs.vx / vs.largo, uy = -vs.vy / vs.largo;
      qx0 = Math.min(X0, X0 + ux * L); qx1 = Math.max(X1, X1 + ux * L);
      qy0 = Math.min(Y0, Y0 + uy * L); qy1 = Math.max(Y1, Y1 + uy * L);
    }
    const inv = 1 / res;
    this.buscar(qx0, qy0, qx1, qy1, i => {
      if (soloHuellas && i >= this.nEdificios) return;
      const m = this.num[i], v0 = this.ini[i], val = soloHuellas ? 1 : this.valor[i];
      if (this.sx.length < m) { this.sx = new Float64Array(m * 2); this.sy = new Float64Array(m * 2); }
      const sx = this.sx, sy = this.sy, cj = this.caja;
      if (soloHuellas) {
        if (cj[4 * i] > X1 || cj[4 * i + 2] < X0 || cj[4 * i + 1] > Y1 || cj[4 * i + 3] < Y0) return;
        for (let k = 0; k < m; k++) { sx[k] = (this.vx[v0 + k] - X0) * inv; sy[k] = (this.vy[v0 + k] - Y0) * inv; }
        rellenar(buf, W, H, sx, sy, m, val);
        return;
      }
      // desplazamientos de la sombra de la base y del techo (con tope de longitud)
      let fb = this.base[i], ft = this.techo[i];
      if (ft * vs.largo > SOMBRA_MAX) ft = SOMBRA_MAX / vs.largo;
      if (fb >= ft) return;
      const bx = vs.vx * fb, by = vs.vy * fb, tx = vs.vx * ft, ty = vs.vy * ft;
      // caja de la sombra
      const mx0 = cj[4 * i] + Math.min(bx, tx), mx1 = cj[4 * i + 2] + Math.max(bx, tx);
      const my0 = cj[4 * i + 1] + Math.min(by, ty), my1 = cj[4 * i + 3] + Math.max(by, ty);
      if (mx0 > X1 || mx1 < X0 || my0 > Y1 || my1 < Y0) return;
      // huella en la base y en el techo
      for (let k = 0; k < m; k++) { sx[k] = (this.vx[v0 + k] + bx - X0) * inv; sy[k] = (this.vy[v0 + k] + by - Y0) * inv; }
      rellenar(buf, W, H, sx, sy, m, val);
      for (let k = 0; k < m; k++) { sx[k] = (this.vx[v0 + k] + tx - X0) * inv; sy[k] = (this.vy[v0 + k] + ty - Y0) * inv; }
      rellenar(buf, W, H, sx, sy, m, val);
      // cuadriláteros de las aristas cuya normal exterior mira hacia donde va la sombra
      const dx = tx - bx, dy = ty - by, signo = this.ccw[i] ? 1 : -1;
      const qx = this.qx || (this.qx = new Float64Array(4)), qy = this.qy || (this.qy = new Float64Array(4));
      for (let k = 0; k < m; k++) {
        const a = v0 + k, b = v0 + (k + 1) % m;
        const ex = this.vx[b] - this.vx[a], ey = this.vy[b] - this.vy[a];
        if (signo * (ey * dx - ex * dy) <= 0) continue;
        const ax = (this.vx[a] - X0) * inv, ay = (this.vy[a] - Y0) * inv, cx = (this.vx[b] - X0) * inv, cy = (this.vy[b] - Y0) * inv;
        qx[0] = ax + bx * inv; qy[0] = ay + by * inv; qx[1] = cx + bx * inv; qy[1] = cy + by * inv;
        qx[2] = cx + tx * inv; qy[2] = cy + ty * inv; qx[3] = ax + tx * inv; qy[3] = ay + ty * inv;
        rellenar(buf, W, H, qx, qy, 4, val);
      }
    });
    return buf;
  }
}

// ------------------------------------------------------------------ sombra por teselas y franjas horarias
export class Sombras {
  constructor(proy, plano) {
    this.proy = proy; this.plano = plano;
    this.franjas = new Map();     // clave de la franja (ms) -> { vs, teselas: Map }
    this.huellas = new Map();     // tesela -> Uint8Array (1 = dentro de un edificio)
  }
  franja(ms) {
    let f = this.franjas.get(ms);
    if (!f) {
      const [lon, lat] = this.plano.ll(0, 0);
      const sol = posicionSol(new Date(ms), lat, lon);
      f = { ms, sol, vs: vectorSombra(sol), teselas: new Map() };
      this.franjas.set(ms, f);
      if (this.franjas.size > 40) this.franjas.delete(this.franjas.keys().next().value);
    }
    return f;
  }
  tesela(f, i, j) {
    const k = i * 100000 + j;
    let t = f.teselas.get(k);
    if (!t) {
      t = new Uint8Array(TESELA * TESELA);
      this.proy.rasterizar(t, i * TESELA, j * TESELA, TESELA, TESELA, 1, f.vs);
      f.teselas.set(k, t);
    }
    return t;
  }
  huella(i, j) {
    const k = i * 100000 + j;
    let t = this.huellas.get(k);
    if (!t) {
      t = new Uint8Array(TESELA * TESELA);
      this.proy.rasterizar(t, i * TESELA, j * TESELA, TESELA, TESELA, 1, null, true);
      this.huellas.set(k, t);
      if (this.huellas.size > 3000) this.huellas.delete(this.huellas.keys().next().value);
    }
    return t;
  }
  // 0..255 en (x, y)
  valor(f, x, y) {
    if (!f.vs.haySol) return 255;
    const i = Math.floor(x / TESELA), j = Math.floor(y / TESELA);
    return this.tesela(f, i, j)[Math.floor(y - j * TESELA) * TESELA + Math.floor(x - i * TESELA)];
  }
  dentroEdificio(x, y) {
    const i = Math.floor(x / TESELA), j = Math.floor(y / TESELA);
    return this.huella(i, j)[Math.floor(y - j * TESELA) * TESELA + Math.floor(x - i * TESELA)] === 1;
  }
  liberar() { for (const f of this.franjas.values()) f.teselas.clear(); this.franjas.clear(); }
}

// ------------------------------------------------------------------ red peatonal
export class Red {
  constructor(red, plano) {
    const A = red.arr, cab = red.cab;
    this.plano = plano;
    this.nombres = cab.nombres || [''];
    const N = A.nx.length, E = A.ea.length;
    this.N = N; this.E = E;
    this.x = new Float32Array(N); this.y = new Float32Array(N); this.z = new Float32Array(N);
    for (let i = 0; i < N; i++) { this.x[i] = A.nx[i] / 10; this.y[i] = A.ny[i] / 10; this.z[i] = A.nz[i] / 10; }
    this.a = A.ea; this.b = A.eb; this.cls = A.ecls; this.flags = A.eflags; this.nom = A.enom;
    this.off = new Float32Array(E);
    for (let e = 0; e < E; e++) this.off[e] = A.eoff[e] / 10;
    // geometría completa de cada tramo (con los extremos)
    let total = 0;
    for (let e = 0; e < E; e++) total += A.egn[e] + 2;
    this.gx = new Float32Array(total); this.gy = new Float32Array(total);
    this.gi = new Uint32Array(E + 1); this.len = new Float32Array(E); this.caja = new Float32Array(4 * E);
    let g = 0;
    for (let e = 0; e < E; e++) {
      this.gi[e] = g;
      let x = A.nx[this.a[e]], y = A.ny[this.a[e]];
      this.gx[g] = x / 10; this.gy[g] = y / 10; g++;
      let d = A.eg0[e] * 2;
      for (let k = 0; k < A.egn[e]; k++) { x += A.gd[d++]; y += A.gd[d++]; this.gx[g] = x / 10; this.gy[g] = y / 10; g++; }
      this.gx[g] = this.x[this.b[e]]; this.gy[g] = this.y[this.b[e]]; g++;
      let L = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (let k = this.gi[e]; k < g; k++) {
        if (k > this.gi[e]) L += Math.hypot(this.gx[k] - this.gx[k - 1], this.gy[k] - this.gy[k - 1]);
        minx = Math.min(minx, this.gx[k]); maxx = Math.max(maxx, this.gx[k]);
        miny = Math.min(miny, this.gy[k]); maxy = Math.max(maxy, this.gy[k]);
      }
      this.len[e] = Math.max(L, 0.1);
      this.caja.set([minx, miny, maxx, maxy], 4 * e);
    }
    this.gi[E] = g;
    // pendiente -> factor de velocidad de Tobler en cada sentido (1 = llano)
    this.vIda = new Float32Array(E); this.vVuelta = new Float32Array(E);
    const tob = s => Math.exp(-3.5 * Math.abs(s + 0.05)) / Math.exp(-3.5 * 0.05);
    for (let e = 0; e < E; e++) {
      const s = Math.max(-0.5, Math.min(0.5, (this.z[this.b[e]] - this.z[this.a[e]]) / Math.max(this.len[e], 12)));
      const esc = this.flags[e] & F.ESCALERA ? 0.6 : 1;
      this.vIda[e] = tob(s) * esc; this.vVuelta[e] = tob(-s) * esc;
    }
    // adyacencia: para cada nodo, tramo·2 + sentido (0 = a→b, 1 = b→a)
    const grado = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) { grado[this.a[e] + 1]++; grado[this.b[e] + 1]++; }
    for (let i = 0; i < N; i++) grado[i + 1] += grado[i];
    this.adyIni = grado; this.ady = new Uint32Array(2 * E);
    const pos = grado.slice(0, N);
    for (let e = 0; e < E; e++) { this.ady[pos[this.a[e]]++] = 2 * e; this.ady[pos[this.b[e]]++] = 2 * e + 1; }
    // rejilla de tramos
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < N; i++) { minx = Math.min(minx, this.x[i]); maxx = Math.max(maxx, this.x[i]); miny = Math.min(miny, this.y[i]); maxy = Math.max(maxy, this.y[i]); }
    this.rej = rejilla(E, this.caja, Math.floor(minx) - 1, Math.floor(miny) - 1,
      Math.ceil((maxx - minx + 3) / CELDA), Math.ceil((maxy - miny + 3) / CELDA));
    this.marca = new Uint32Array(E); this.sello = 0;
    // etiquetas del A* (se reutilizan entre búsquedas)
    this.g = new Float64Array(N); this.t = new Float64Array(N); this.prev = new Int32Array(N);
    this.cerrado = new Uint32Array(N); this.visto = new Uint32Array(N); this.vuelta = 0;
    // sombra medida de cada tramo por franja: fracción a la sombra y lado
    this.medidas = new Map();
  }

  // punto de la red más cercano a (x, y): tramo, distancia desde a, distancia al punto
  cercano(x, y, radio = 300) {
    const R = this.rej;
    let mejor = null;
    const s = ++this.sello;
    for (let anillo = 0; anillo * CELDA <= radio + CELDA; anillo++) {
      const cx = Math.floor((x - R.x0) / CELDA), cy = Math.floor((y - R.y0) / CELDA);
      for (let r = cy - anillo; r <= cy + anillo; r++) for (let c = cx - anillo; c <= cx + anillo; c++) {
        if (Math.max(Math.abs(r - cy), Math.abs(c - cx)) !== anillo) continue;
        if (r < 0 || c < 0 || r >= R.ny || c >= R.nx) continue;
        const k = r * R.nx + c;
        for (let j = R.ini[k]; j < R.ini[k + 1]; j++) {
          const e = R.items[j];
          if (this.marca[e] === s) continue;
          this.marca[e] = s;
          let acum = 0;
          for (let q = this.gi[e]; q < this.gi[e + 1] - 1; q++) {
            const ax = this.gx[q], ay = this.gy[q], bx = this.gx[q + 1], by = this.gy[q + 1];
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, ls = Math.sqrt(l2);
            const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
            const px = ax + u * dx, py = ay + u * dy, d = Math.hypot(x - px, y - py);
            if (!mejor || d < mejor.d) mejor = { e, s: acum + u * ls, d, px, py };
            acum += ls;
          }
        }
      }
      if (mejor && mejor.d < anillo * CELDA) break;
    }
    return mejor && mejor.d <= radio ? mejor : null;
  }

  // Muestrea la sombra de un tramo (entero o el trozo [s0, s1]) en la franja f.
  // Devuelve { frac, lado } con lado: 0 centro, 1 acera izquierda, -1 acera derecha (sentido a→b).
  medir(sombras, f, e, s0 = 0, s1 = Infinity, puntos = null) {
    const fl = this.flags[e];
    if (fl & F.CUBIERTO) return { frac: 1, lado: 0, sol: 0 };
    if (!f.vs.haySol) return { frac: 1, lado: 0, sol: 0 };
    const lados = [];
    if (fl & F.CENTRO || !(fl & (F.IZQ | F.DER))) lados.push(0);
    if (fl & F.IZQ) lados.push(1);
    if (fl & F.DER) lados.push(-1);
    const off = this.off[e], acc = new Float64Array(3), tot = { l: 0 };
    let acum = 0;
    const g0 = this.gi[e], g1 = this.gi[e + 1];
    for (let q = g0; q < g1 - 1; q++) {
      const ax = this.gx[q], ay = this.gy[q], bx = this.gx[q + 1], by = this.gy[q + 1];
      const ls = Math.hypot(bx - ax, by - ay);
      if (ls < 1e-6) continue;
      const a0 = Math.max(s0, acum), a1 = Math.min(s1, acum + ls);
      if (a1 > a0) {
        const nx = -(by - ay) / ls, ny = (bx - ax) / ls;        // normal a la izquierda
        const n = Math.max(1, Math.ceil((a1 - a0) / PASO)), w = (a1 - a0) / n;
        for (let k = 0; k < n; k++) {
          const u = (a0 + (k + 0.5) * w - acum) / ls;
          const px = ax + u * (bx - ax), py = ay + u * (by - ay);
          for (let li = 0; li < lados.length; li++) {
            const lado = lados[li];
            let qx = px, qy = py;
            if (lado !== 0) {
              qx = px + lado * off * nx; qy = py + lado * off * ny;
              if (sombras.dentroEdificio(qx, qy)) {
                qx = px + lado * off * 0.5 * nx; qy = py + lado * off * 0.5 * ny;
                if (sombras.dentroEdificio(qx, qy)) { qx = px; qy = py; }
              }
            }
            const v = sombras.valor(f, qx, qy) / 255;
            acc[lado + 1] += w * v;
            if (puntos) puntos.push(lado, qx, qy, v);
          }
          tot.l += w;
        }
      }
      acum += ls;
      if (acum >= s1) break;
    }
    let mejor = lados[0], mv = -1;
    for (const l of lados) if (acc[l + 1] > mv + 1e-9) { mv = acc[l + 1]; mejor = l; }
    return { frac: tot.l > 0 ? mv / tot.l : 0, lado: mejor };
  }

  medida(sombras, f, e) {
    let m = this.medidas.get(f.ms);
    if (!m) {
      m = { frac: new Float32Array(this.E).fill(-1), lado: new Int8Array(this.E) };
      this.medidas.set(f.ms, m);
      if (this.medidas.size > 12) this.medidas.delete(this.medidas.keys().next().value);
    }
    if (m.frac[e] < 0) {
      const r = this.medir(sombras, f, e);
      m.frac[e] = r.frac; m.lado[e] = r.lado;
    }
    return m.frac[e];
  }
  ladoMedido(f, e) { return this.medidas.get(f.ms)?.lado[e] ?? 0; }
}

// ------------------------------------------------------------------ montículo binario
class Monticulo {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(clave, valor) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(clave); v.push(valor);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= clave) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = clave; v[i] = valor;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], ultK = k.pop(), ultV = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let h = 2 * i + 1;
        if (h >= n) break;
        if (h + 1 < n && k[h + 1] < k[h]) h++;
        if (k[h] >= ultK) break;
        k[i] = k[h]; v[i] = v[h]; i = h;
      }
      k[i] = ultK; v[i] = ultV;
    }
    return top;
  }
  minClave() { return this.k[0]; }
}

// ------------------------------------------------------------------ rutas
export class Rutero {
  constructor(red, sombras) { this.red = red; this.sombras = sombras; }

  // franja (instante de inicio, en ms) que corresponde a 'seg' segundos después de la salida
  franjaDe(salida, seg) { return this.sombras.franja(salida + Math.floor(seg / FRANJA) * FRANJA * 1000); }

  // A* con coste = sombra + (1 + beta)·sol. o, d: puntos de la red (Red.cercano).
  buscar(o, d, salida, opc) {
    const R = this.red, beta = opc.beta, vel = opc.velocidad / 3.6, escaleras = opc.escaleras !== false;
    const vuelta = ++R.vuelta, g = R.g, t = R.t, prev = R.prev, cerrado = R.cerrado, visto = R.visto;
    const dx = R.x, dy = R.y, tx = d.px, ty = d.py;
    const h = n => Math.hypot(dx[n] - tx, dy[n] - ty);
    const coste = (e, sentido, tSeg, longitud) => {
      const f = this.franjaDe(salida, tSeg);
      const frac = R.medida(this.sombras, f, e);
      let c = longitud * (1 + beta * (1 - frac));
      if (R.flags[e] & F.ACERA_APARTE) c *= 1.25;               // calzada con acera dibujada aparte
      const v = vel * (sentido ? R.vVuelta[e] : R.vIda[e]);
      return [c, longitud / v];
    };
    const heap = new Monticulo();
    // solo se exploran los nodos de la elipse con focos en el origen y el destino cuya suma de
    // distancias no pasa del tope: ninguna ruta más larga que el tope puede salirse de ella
    const el = opc.elipse;
    const abrir = (n, gn, tn, pe) => {
      if (visto[n] !== vuelta || gn < g[n]) {
        if (el && Math.hypot(dx[n] - el.ox, dy[n] - el.oy) + Math.hypot(dx[n] - el.dx, dy[n] - el.dy) > el.tope) return;
        visto[n] = vuelta; g[n] = gn; t[n] = tn; prev[n] = pe;
        heap.push(gn + h(n), n);
      }
    };
    // salida: del punto a los dos extremos de su tramo
    const eo = o.e, lo = R.len[eo];
    const [ca, ta] = coste(eo, 1, 0, o.s), [cb, tb] = coste(eo, 0, 0, lo - o.s);
    abrir(R.a[eo], ca, ta, -1); abrir(R.b[eo], cb, tb, -2);
    // llegada
    let gD = Infinity, tD = 0, desdeD = -1;
    const ed = d.e, ld = R.len[ed];
    if (eo === ed) {                                              // mismo tramo: directo
      const [c, tt] = coste(eo, d.s < o.s ? 1 : 0, 0, Math.abs(d.s - o.s));
      gD = c; tD = tt; desdeD = -3;
    }
    let expandidos = 0;
    while (heap.size) {
      if (heap.minClave() >= gD) break;
      const u = heap.pop();
      if (cerrado[u] === vuelta) continue;
      cerrado[u] = vuelta; expandidos++;
      if (expandidos > 600000) break;
      // ¿llega al destino por su tramo?
      if (u === R.a[ed] || u === R.b[ed]) {
        const desdeA = u === R.a[ed];
        const [c, tt] = coste(ed, desdeA ? 0 : 1, t[u], desdeA ? d.s : ld - d.s);
        if (g[u] + c < gD) { gD = g[u] + c; tD = t[u] + tt; desdeD = u; }
      }
      for (let j = R.adyIni[u]; j < R.adyIni[u + 1]; j++) {
        const code = R.ady[j], e = code >> 1, sentido = code & 1;
        if (!escaleras && R.flags[e] & F.ESCALERA) continue;
        const w = sentido ? R.a[e] : R.b[e];
        if (cerrado[w] === vuelta) continue;
        const [c, tt] = coste(e, sentido, t[u], R.len[e]);
        abrir(w, g[u] + c, t[u] + tt, code);
      }
    }
    if (!isFinite(gD)) return null;
    // reconstrucción: lista de [tramo, sentido, s0, s1] en el orden de la marcha
    const piezas = [];
    if (desdeD === -3) {
      piezas.push([eo, d.s < o.s ? 1 : 0, Math.min(o.s, d.s), Math.max(o.s, d.s)]);
    } else {
      const desdeA = desdeD === R.a[ed];
      piezas.push([ed, desdeA ? 0 : 1, desdeA ? 0 : d.s, desdeA ? d.s : ld]);
      let n = desdeD;
      for (;;) {
        const pe = prev[n];
        if (pe === -1) { piezas.push([eo, 1, 0, o.s]); break; }          // de o hacia a
        if (pe === -2) { piezas.push([eo, 0, o.s, lo]); break; }         // de o hacia b
        const e = pe >> 1, sentido = pe & 1;
        piezas.push([e, sentido, 0, R.len[e]]);
        n = sentido ? R.b[e] : R.a[e];
      }
      piezas.reverse();
    }
    return { piezas, coste: gD, seg: tD, expandidos };
  }

  // Detalle de una ruta: longitud, metros a la sombra, puntos (con el lado elegido) e instrucciones.
  detallar(ruta, salida, opc) {
    const R = this.red, S = this.sombras, vel = opc.velocidad / 3.6;
    let tSeg = 0, dist = 0, sombraM = 0, subida = 0, escalones = 0;
    const puntos = [], tramos = [];
    for (const [e, sentido, s0, s1] of ruta.piezas) {
      const L = s1 - s0;
      if (L <= 0.05) continue;
      const f = this.franjaDe(salida, tSeg);
      const muestras = [];
      const m = R.medir(S, f, e, s0, s1, muestras);
      // puntos del lado elegido, en el sentido de la marcha
      const pts = [];
      for (let k = 0; k < muestras.length; k += 4) if (muestras[k] === m.lado) pts.push([muestras[k + 1], muestras[k + 2], muestras[k + 3]]);
      if (sentido) pts.reverse();
      for (const p of pts) puntos.push(p);
      const v = vel * (sentido ? R.vVuelta[e] : R.vIda[e]);
      const dz = (R.z[R.b[e]] - R.z[R.a[e]]) * (L / R.len[e]) * (sentido ? -1 : 1);
      if (dz > 0) subida += dz;
      if (R.flags[e] & F.ESCALERA) escalones++;
      tramos.push({ e, sentido, s0, s1, L, frac: m.frac, lado: sentido ? -m.lado : m.lado, t: tSeg,
                    nombre: R.nombres[R.nom[e]] || '', cls: R.cls[e], flags: R.flags[e] });
      dist += L; sombraM += L * m.frac; tSeg += L / v;
    }
    return { dist, sombraM, solM: dist - sombraM, pct: dist > 0 ? sombraM / dist : 0, seg: tSeg, subida, escalones,
             puntos, tramos, instrucciones: instrucciones(R, tramos) };
  }

  // Varias rutas: la más corta y las que dan más sombra sin pasar del rodeo máximo.
  rutas(oLL, dLL, salida, opc) {
    const R = this.red, P = R.plano;
    const o = R.cercano(...P.xy(...oLL)), d = R.cercano(...P.xy(...dLL));
    if (!o || !d) return { error: !o ? 'origen' : 'destino' };
    const f0 = this.sombras.franja(salida);
    const res = [];
    const prueba = (beta, elipse) => {
      const r = this.buscar(o, d, salida, { ...opc, beta, elipse });
      if (!r) return null;
      const det = this.detallar(r, salida, opc);
      det.beta = beta; det.clave = r.piezas.map(p => p[0]).join(',');
      return det;
    };
    const recta = Math.hypot(d.px - o.px, d.py - o.py);
    const corta = prueba(0, { ox: o.px, oy: o.py, dx: d.px, dy: d.py, tope: 3 * recta + 1500 });
    if (!corta) return { error: 'sin_camino' };
    res.push(corta);
    const tope = corta.dist * (1 + opc.rodeo);
    const haySol = f0.vs.haySol || this.franjaDe(salida, corta.seg).vs.haySol;
    const elipse = { ox: o.px, oy: o.py, dx: d.px, dy: d.py, tope: tope + 20 };
    if (haySol) for (const beta of [0.5, 1.2, 2.5, 5, 10]) { const r = prueba(beta, elipse); if (r) res.push(r); }
    // elección
    const validas = res.filter(r => r.dist <= tope + 1);
    const sombra = validas.reduce((a, r) => (r.solM < a.solM - 1 ? r : a), corta);
    const elegidas = [];
    const marca = (r, tipo) => { if (!elegidas.some(x => x.clave === r.clave)) { r.tipo = tipo; elegidas.push(r); } };
    if (haySol && sombra !== corta && corta.solM - sombra.solM >= 15) marca(sombra, 'sombra');
    // intermedia: la que más sol ahorra por metro de rodeo, si es distinta y aporta
    if (haySol && elegidas.length) {
      let mejor = null, ratio = 0;
      for (const r of validas) {
        if (r.clave === sombra.clave || r.clave === corta.clave) continue;
        const ahorro = corta.solM - r.solM, extra = Math.max(r.dist - corta.dist, 1);
        if (ahorro > 15 && ahorro / extra > ratio && r.solM < corta.solM - 0.4 * (corta.solM - sombra.solM)) { ratio = ahorro / extra; mejor = r; }
      }
      if (mejor) marca(mejor, 'equilibrada');
    }
    marca(corta, 'corta');
    return {
      rutas: elegidas.map(r => this.paraMapa(r)),
      sol: { alt: f0.sol.altG, az: f0.sol.az, haySol: f0.vs.haySol },
      snap: { o: P.ll(o.px, o.py), d: P.ll(d.px, d.py), dO: o.d, dD: d.d },
      sinSol: !haySol,
    };
  }

  // a lon/lat y sin los arrays internos
  paraMapa(r) {
    const P = this.red.plano;
    return {
      tipo: r.tipo, dist: r.dist, sombraM: r.sombraM, solM: r.solM, pct: r.pct, seg: r.seg, subida: r.subida,
      escalones: r.escalones, instrucciones: r.instrucciones,
      puntos: r.puntos.map(([x, y, v]) => { const [lon, lat] = P.ll(x, y); return [+lon.toFixed(6), +lat.toFixed(6), +v.toFixed(2)]; }),
    };
  }
}

// ------------------------------------------------------------------ instrucciones
const TIPO_VIA = ['camino', 'calle', 'calle', 'avenida', 'avenida', 'avenida'];
function rumbo(R, tr, alFinal) {
  // dirección de la marcha (grados desde el norte) cerca del principio o del final de un trozo
  const e = tr.e, g0 = R.gi[e], g1 = R.gi[e + 1];
  const pts = [];
  let acum = 0;
  for (let q = g0; q < g1; q++) {
    if (q > g0) acum += Math.hypot(R.gx[q] - R.gx[q - 1], R.gy[q] - R.gy[q - 1]);
    pts.push([R.gx[q], R.gy[q], acum]);
  }
  const en = s => {
    for (let k = 1; k < pts.length; k++) if (pts[k][2] >= s) {
      const u = (s - pts[k - 1][2]) / Math.max(pts[k][2] - pts[k - 1][2], 1e-9);
      return [pts[k - 1][0] + u * (pts[k][0] - pts[k - 1][0]), pts[k - 1][1] + u * (pts[k][1] - pts[k - 1][1])];
    }
    return [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  };
  const L = Math.min(12, tr.s1 - tr.s0);
  let s0, s1;
  if (tr.sentido === 0) { [s0, s1] = alFinal ? [tr.s1 - L, tr.s1] : [tr.s0, tr.s0 + L]; }
  else { [s0, s1] = alFinal ? [tr.s0 + L, tr.s0] : [tr.s1, tr.s1 - L]; }
  const [ax, ay] = en(s0), [bx, by] = en(s1);
  return Math.atan2(bx - ax, by - ay) / RAD;
}
function descripcion(R, tr) {
  if (tr.nombre) return tr.nombre;
  if (tr.flags & F.ESCALERA) return 'las escaleras';
  if (tr.flags & F.CRUCE) return 'el paso de peatones';
  return tr.cls === 0 ? 'el camino peatonal' : 'la calle';
}
const normal = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const RUMBOS = ['el norte', 'el noreste', 'el este', 'el sureste', 'el sur', 'el suroeste', 'el oeste', 'el noroeste'];

// Agrupa los trozos de la ruta en pasos: misma vía = un paso; los trocitos sin nombre (pasos de
// peatones, enlaces de pocos metros) se funden con el paso anterior.
export function instrucciones(R, tramos) {
  const nuevo = tr => {
    const g = { nombre: descripcion(R, tr), L: 0, sombra: 0, ini: tr, fin: tr, t: tr.t, lados: [0, 0, 0] };
    g.clave = normal(g.nombre);
    return g;
  };
  const suma = (g, tr) => { g.L += tr.L; g.sombra += tr.L * tr.frac; g.fin = tr; g.lados[tr.lado + 1] += tr.L; };
  let grupos = [];
  for (const tr of tramos) {
    const g = grupos[grupos.length - 1], clave = normal(descripcion(R, tr));
    if (g && (g.clave === clave || (!tr.nombre && tr.L < 25))) { suma(g, tr); continue; }
    const n = nuevo(tr); suma(n, tr); grupos.push(n);
  }
  // un paso muy corto entre otros dos se funde con el anterior, y se vuelven a unir los de la misma vía
  for (let pasada = 0; pasada < 2; pasada++) {
    const out = [];
    for (let i = 0; i < grupos.length; i++) {
      const g = grupos[i], prev = out[out.length - 1];
      if (prev && (prev.clave === g.clave || (g.L < 20 && i < grupos.length - 1))) {
        prev.L += g.L; prev.sombra += g.sombra; prev.fin = g.fin;
        for (let k = 0; k < 3; k++) prev.lados[k] += g.lados[k];
        continue;
      }
      out.push(g);
    }
    grupos = out;
  }
  const pasos = grupos.map((p, i) => {
    let texto;
    const giro = i ? (((rumbo(R, p.ini, false) - rumbo(R, grupos[i - 1].fin, true)) % 360 + 540) % 360) - 180 : null;
    if (i === 0) {
      const r = ((rumbo(R, p.ini, false) % 360) + 360) % 360;
      texto = `Ve hacia ${RUMBOS[Math.round(r / 45) % 8]} por ${p.nombre}`;
    } else {
      const a = Math.abs(giro), lado = giro > 0 ? 'derecha' : 'izquierda';
      const verbo = a < 25 ? 'Sigue recto por' : a < 60 ? `Gira ligeramente a la ${lado} por` : a < 150 ? `Gira a la ${lado} por` : 'Da la vuelta por';
      texto = `${verbo} ${p.nombre}`;
    }
    // acera: la que ocupa al menos el 60 % del paso (lados medidos en el sentido de la marcha)
    const [der, cen, izq] = p.lados, tot = der + cen + izq;
    const acera = tot > 0 && izq / tot >= 0.6 ? 'izquierda' : tot > 0 && der / tot >= 0.6 ? 'derecha' : null;
    return { texto, acera, m: Math.round(p.L), pct: p.L > 0 ? p.sombra / p.L : 0, t: p.t, giro };
  });
  pasos.push({ texto: 'Llegas a tu destino', acera: null, m: 0, pct: null, t: null, giro: null, fin: true });
  return pasos;
}

// ------------------------------------------------------------------ imagen de sombras para el mapa
// Ventana en metros; devuelve RGBA (fila 0 = norte) con la sombra en azul marino translúcido y los
// edificios transparentes (ya los dibuja el mapa).
export function imagenSombras(proy, x0, y0, x1, y1, maxPx, vs, opacidad = 0.42) {
  const res = Math.max(0.5, Math.max(x1 - x0, y1 - y0) / maxPx);
  const W = Math.ceil((x1 - x0) / res), H = Math.ceil((y1 - y0) / res);
  const s = new Uint8Array(W * H), hu = new Uint8Array(W * H);
  proy.rasterizar(s, x0, y0, W, H, res, vs);
  proy.rasterizar(hu, x0, y0, W, H, res, null, true);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let r = 0; r < H; r++) {
    const src = (H - 1 - r) * W;          // la imagen va de norte a sur
    for (let c = 0; c < W; c++) {
      const v = s[src + c], o = (r * W + c) * 4;
      if (!v || hu[src + c]) continue;
      rgba[o] = 22; rgba[o + 1] = 38; rgba[o + 2] = 92; rgba[o + 3] = Math.round(v * opacidad);
    }
  }
  return { rgba, W, H, res };
}
