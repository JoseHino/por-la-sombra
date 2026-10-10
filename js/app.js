// Por la sombra · interfaz: acceso, mapa, buscador, rutas y navegación.
import { PREFERENCIAS, CENTRO } from './config.js';
import * as C from './cuentas.js';
import * as B from './buscador.js';
import { posicionSol, fechaMadrid } from './motor.js';

const BASE = new URL('../', import.meta.url).href;
const $ = id => document.getElementById(id);
const html = (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? v[i] ?? '' : ''), '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (id, cls = '') => `<svg class="ico ${cls}"><use href="#i-${id}"/></svg>`;

const estado = {
  usuario: null, perfil: null, prefs: { ...PREFERENCIAS }, sitios: [], historial: [],
  origen: null, destino: null, salida: null,      // salida: null = ahora; si no, ms
  rutas: [], sel: 0, res: null, yo: null, vigilando: null,
  sombras: true, fondo: 'mapa', navegando: false, campo: null, eligiendoEnMapa: null, meta: null,
};

// ------------------------------------------------------------------ utilidades de formato y hora (Madrid)
const FMT = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
function partes(ms) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, wd: p.weekday };
}
const hhmm = ms => { const p = partes(ms); return `${p.h}:${String(p.min).padStart(2, '0')}`; };
const hoyMadrid = () => { const p = partes(Date.now()); return `${p.y}-${p.m}-${p.d}`; };
const fechaLarga = ms => new Date(ms).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short' });
const instante = () => estado.salida ?? Date.now();
const fmtDist = m => m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`;
const fmtMin = s => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const pct = v => `${Math.round(v * 100)} %`;
const RUMBO = ['el norte', 'el noreste', 'el este', 'el sureste', 'el sur', 'el suroeste', 'el oeste', 'el noroeste'];
const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const rumbo = az => RUMBO[Math.round(((az % 360) + 360) % 360 / 45) % 8];
const cardinal = az => CARDINAL[Math.round(((az % 360) + 360) % 360 / 45) % 8];
const distM = (a, b) => Math.hypot((a[0] - b[0]) * 89590, (a[1] - b[1]) * 110968);

let tAviso;
function aviso(txt, ms = 4200) {
  const a = $('aviso'); a.textContent = txt; a.hidden = false;
  clearTimeout(tAviso); tAviso = setTimeout(() => { a.hidden = true; }, ms);
}

// ------------------------------------------------------------------ motor (worker)
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let nMsg = 0;
const pendientes = new Map();
worker.onmessage = ({ data }) => {
  const p = pendientes.get(data.id);
  if (!p) return;
  pendientes.delete(data.id);
  data.ok ? p.ok(data.r) : p.ko(new Error(data.error));
};
worker.onerror = e => { console.error('Worker:', e.message); };
const motor = (tipo, datos = {}) => new Promise((ok, ko) => { const id = ++nMsg; pendientes.set(id, { ok, ko }); worker.postMessage({ id, tipo, ...datos }); });

const arranque = (async () => {
  estado.meta = await (await fetch(BASE + 'data/meta.json', { cache: 'no-cache' })).json();
  const [r] = await Promise.all([motor('iniciar', { base: BASE }), B.cargar(BASE, estado.meta)]);
  return r;
})();

// ------------------------------------------------------------------ acceso
let modoAcceso = 'entrar', sondeo = null;
function mostrarAcceso(pantalla, email) {
  $('app').hidden = true; $('acceso').hidden = false;
  $('accesoForm').hidden = pantalla !== 'form';
  $('accesoVerifica').hidden = pantalla !== 'verifica';
  $('accesoPendiente').hidden = pantalla !== 'pendiente';
  clearInterval(sondeo);
  if (pantalla === 'verifica') {
    $('verificaEmail').textContent = email;
    sondeo = setInterval(() => C.recargar().catch(() => {}), 4000);
  }
}
function msgAcceso(txt, tipo = 'error', id = 'accesoMsg') {
  const m = $(id); m.textContent = txt; m.className = 'msg ' + tipo; m.hidden = !txt;
}
function modo(m) {
  modoAcceso = m;
  document.querySelectorAll('.pestanas button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.modo === m)));
  document.querySelectorAll('[data-solo="crear"]').forEach(el => { el.hidden = m !== 'crear'; });
  $('btnAcceso').textContent = m === 'crear' ? 'Crear cuenta' : 'Entrar';
  $('formAcceso').clave.autocomplete = m === 'crear' ? 'new-password' : 'current-password';
  $('btnOlvido').hidden = m === 'crear';
  msgAcceso('');
}
document.querySelectorAll('.pestanas button').forEach(b => b.addEventListener('click', () => modo(b.dataset.modo)));
$('formAcceso').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, email = f.email.value.trim(), clave = f.clave.value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return msgAcceso('Escribe un correo válido.');
  if (!clave) return msgAcceso('Escribe la contraseña.');
  $('btnAcceso').disabled = true;
  try {
    if (modoAcceso === 'crear') await C.crearCuenta(f.nombre.value, email, clave, f.anonimo.checked);
    else await C.entrarCorreo(email, clave);
    msgAcceso('');
  } catch (err) { msgAcceso(C.mensajeError(err)); }
  $('btnAcceso').disabled = false;
});
$('btnGoogle').addEventListener('click', async () => {
  try { await C.entrarGoogle(); } catch (err) { msgAcceso(C.mensajeError(err)); }
});
$('btnOlvido').addEventListener('click', async () => {
  const email = $('formAcceso').email.value.trim();
  if (!email) return msgAcceso('Escribe tu correo arriba y vuelve a pulsar.');
  try { await C.recordarClave(email); msgAcceso('Te hemos enviado un correo para elegir una contraseña nueva.', 'ok'); }
  catch (err) { msgAcceso(C.mensajeError(err)); }
});
$('btnYaVerificado').addEventListener('click', async () => {
  const u = await C.recargar().catch(() => null);
  if (!u?.verificado) msgAcceso('Todavía no consta como verificado. Abre el enlace del correo (mira también en "Spam").', 'error', 'verificaMsg');
});
$('btnReenviar').addEventListener('click', async () => {
  try { await C.reenviarVerificacion(); msgAcceso('Correo reenviado.', 'ok', 'verificaMsg'); }
  catch (err) { msgAcceso(C.mensajeError(err), 'error', 'verificaMsg'); }
});
$('btnOtraCuenta').addEventListener('click', () => C.salir());
$('btnSinCuenta').addEventListener('click', () => {
  try { localStorage.setItem('pls_sin_cuenta', '1'); } catch { /* sin almacenamiento */ }
  C.entrarSinCuenta();
});

async function alCambiarUsuario(u) {
  estado.usuario = u;
  if (!u) {
    estado.dentro = null;
    if (estado.navegando) terminarNavegacion();
    mostrarAcceso(C.configurado ? 'form' : 'pendiente');
    return;
  }
  if (!u.verificado && u.proveedor === 'password') { mostrarAcceso('verifica', u.email); return; }
  clearInterval(sondeo);
  if (estado.dentro === u.uid) return;
  estado.dentro = u.uid;
  $('acceso').hidden = true; $('app').hidden = false;
  pintarAvatar();
  await entrarEnApp();
}

// ------------------------------------------------------------------ app
let mapa = null;
async function entrarEnApp() {
  if (!mapa) iniciarMapa();
  try {
    await C.asegurarPerfil(estado.usuario, {});
    estado.perfil = await C.leerPerfil();
    estado.prefs = { ...PREFERENCIAS, ...(estado.perfil.prefs || {}) };
    [estado.sitios, estado.historial] = await Promise.all([C.listarSitios(), C.listarHistorial()]);
  } catch (e) {
    console.warn('Perfil:', e);
    aviso('No se han podido leer tus datos guardados. La app funciona igual.');
  }
  pintarChipAjustes();
  try {
    await arranque;
    $('cargando').hidden = true;
  } catch (e) {
    $('cargandoTxt').innerHTML = `No se han podido cargar los datos de Marbella.<br><small>${esc(e.message)}</small><br><br><button class="btn" id="btnReintentar" type="button">Reintentar</button>`;
    $('btnReintentar').addEventListener('click', () => location.reload());
    return;
  }
  pintarInicio();
  prepararUbicacion();
}
function pintarAvatar() {
  const u = estado.usuario, inicial = (u.nombre || u.email || '·').trim()[0]?.toUpperCase() || '·';
  for (const el of [$('btnPerfil'), $('perfilAvatar')]) {
    el.innerHTML = u.foto ? `<img src="${esc(u.foto)}" alt="" referrerpolicy="no-referrer">` : esc(inicial);
  }
  $('perfilNombre').textContent = u.nombre || '';
  $('perfilEmail').textContent = u.email || '';
}

// ------------------------------------------------------------------ mapa
const ESTILO = { claro: 'https://tiles.openfreemap.org/styles/positron', oscuro: 'https://tiles.openfreemap.org/styles/dark' };
const temaOscuro = () => document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const IGN = 'https://www.ign.es/wmts/pnoa-ma?layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}';
let marcaO = null, marcaD = null, marcaYo = null;

function iniciarMapa() {
  mapa = new maplibregl.Map({
    container: 'mapa', style: temaOscuro() ? ESTILO.oscuro : ESTILO.claro, center: CENTRO, zoom: 15.2, minZoom: 10.5, maxZoom: 19.5,
    maxBounds: [[-5.35, 36.30], [-4.45, 36.75]], dragRotate: false, pitchWithRotate: false, touchPitch: false,
    attributionControl: { compact: true, customAttribution: 'Edificios: <a href="https://www.catastro.hacienda.gob.es/" target="_blank" rel="noopener">Catastro</a> · Red peatonal y árboles: © colaboradores de <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
  });
  mapa.on('style.load', instalarCapas);
  mapa.once('load', () => { if (innerWidth < 900) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'); });
  mapa.on('moveend', programarSombras);
  mapa.on('click', alPulsarMapa);
  mapa.on('dragstart', () => { if (estado.navegando) estado.seguir = false; });
  mapa.on('click', 'rutas-alt', e => elegirRuta(e.features[0].properties.i));
  mapa.on('mouseenter', 'rutas-alt', () => { mapa.getCanvas().style.cursor = 'pointer'; });
  mapa.on('mouseleave', 'rutas-alt', () => { mapa.getCanvas().style.cursor = ''; });
}

function instalarCapas() {
  const capas = mapa.getStyle().layers;
  const primerRotulo = capas.find(l => l.type === 'symbol')?.id;
  const primeraCalle = capas.find(l => l.type === 'line' && /highway|road|transportation/.test(l.id))?.id || primerRotulo;
  if (!mapa.getSource('orto')) mapa.addSource('orto', { type: 'raster', tiles: [IGN], tileSize: 256, maxzoom: 19, attribution: 'Ortofoto PNOA © IGN' });
  mapa.addLayer({ id: 'orto', type: 'raster', source: 'orto', layout: { visibility: estado.fondo === 'orto' ? 'visible' : 'none' } }, primeraCalle);
  mapa.addSource('termino', { type: 'geojson', data: BASE + 'data/termino.geojson' });
  mapa.addLayer({ id: 'termino', type: 'line', source: 'termino', paint: { 'line-color': '#1c5cab', 'line-width': 1.5, 'line-opacity': 0.45, 'line-dasharray': [3, 2] } }, primerRotulo);
  // sombras: imagen que calcula el worker para la vista
  mapa.addSource('sombras', { type: 'image', url: imagenVacia(), coordinates: [[-4.9, 36.52], [-4.89, 36.52], [-4.89, 36.51], [-4.9, 36.51]] });
  mapa.addLayer({ id: 'sombras', type: 'raster', source: 'sombras', paint: { 'raster-fade-duration': 0, 'raster-opacity': 1, 'raster-resampling': 'linear' },
                  layout: { visibility: estado.sombras ? 'visible' : 'none' } }, primerRotulo);
  mapa.addSource('rutas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  mapa.addLayer({ id: 'rutas-alt', type: 'line', source: 'rutas', filter: ['==', ['get', 'alt'], 1],
                  layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7d8ca3', 'line-width': 6, 'line-opacity': 0.75 } }, primerRotulo);
  mapa.addLayer({ id: 'ruta-conector', type: 'line', source: 'rutas', filter: ['==', ['get', 'con'], 1],
                  layout: { 'line-cap': 'round' }, paint: { 'line-color': '#6b7c94', 'line-width': 3, 'line-dasharray': [0.5, 2] } }, primerRotulo);
  mapa.addLayer({ id: 'ruta-borde', type: 'line', source: 'rutas', filter: ['==', ['get', 'alt'], 0],
                  layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 10 } }, primerRotulo);
  mapa.addLayer({ id: 'ruta', type: 'line', source: 'rutas', filter: ['==', ['get', 'alt'], 0],
                  layout: { 'line-cap': 'round', 'line-join': 'round' },
                  paint: { 'line-color': ['case', ['==', ['get', 's'], 1], '#1a5fd0', '#f29900'], 'line-width': 6 } }, primerRotulo);
  if (estado.rutas.length) pintarRutas(false);
  ultimaSombra = null;
  programarSombras();
}

function imagenVacia() {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  return c.toDataURL();
}

// sombras de la vista
let tSombras = null, pedidoSombras = 0, ultimaSombra = null, urlSombra = null;
function programarSombras() { clearTimeout(tSombras); tSombras = setTimeout(pedirSombras, 180); }
async function pedirSombras() {
  if (!mapa || !mapa.getSource('sombras')) return;
  pintarSolChip();
  const visible = estado.sombras && mapa.getZoom() >= 14;
  mapa.setLayoutProperty('sombras', 'visibility', visible ? 'visible' : 'none');
  if (!visible) return;
  const b = mapa.getBounds(), c = mapa.getCenter();
  // ventana algo mayor que la vista y como mucho de 3 km de lado
  const mx = Math.min((b.getEast() - b.getWest()) * 0.6, 0.017), my = Math.min((b.getNorth() - b.getSouth()) * 0.6, 0.0135);
  const bbox = [c.lng - mx, c.lat - my, c.lng + mx, c.lat + my];
  const ms = instante();
  const clave = bbox.map(v => v.toFixed(4)).join() + '|' + Math.floor(ms / 60000);
  if (clave === ultimaSombra) return;
  const yo = ++pedidoSombras;
  try {
    await arranque;
    const maxPx = Math.min(1600, Math.round(Math.max(innerWidth, innerHeight) * Math.min(devicePixelRatio, 2) * 0.9));
    const r = await motor('sombras', { bbox, ms, maxPx });
    if (yo !== pedidoSombras) return;
    ultimaSombra = clave;
    if (r.vacia) { mapa.setLayoutProperty('sombras', 'visibility', 'none'); return; }
    const cv = document.createElement('canvas'); cv.width = r.W; cv.height = r.H;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer || r.rgba), r.W, r.H), 0, 0);
    const blob = await new Promise(ok => cv.toBlob(ok, 'image/png'));
    const url = URL.createObjectURL(blob);
    mapa.getSource('sombras').updateImage({ url, coordinates: r.esquinas });
    if (urlSombra) { const vieja = urlSombra; setTimeout(() => URL.revokeObjectURL(vieja), 3000); }
    urlSombra = url;
  } catch (e) { console.warn('Sombras:', e); }
}

// ------------------------------------------------------------------ chip del sol y tiempo (Open-Meteo)
let meteo = null, meteoT = 0;
async function cargarMeteo() {
  if (meteo && Date.now() - meteoT < 30 * 60000) return meteo;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${CENTRO[1]}&longitude=${CENTRO[0]}&hourly=temperature_2m,apparent_temperature,uv_index&timezone=Europe%2FMadrid&past_days=1&forecast_days=16`;
    meteo = (await (await fetch(u)).json()).hourly; meteoT = Date.now();
  } catch { meteo = null; }
  return meteo;
}
function tiempoEn(ms) {
  if (!meteo) return null;
  const p = partes(ms);
  const k = meteo.time.indexOf(`${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:00`);
  return k < 0 ? null : { t: meteo.temperature_2m[k], st: meteo.apparent_temperature[k], uv: meteo.uv_index[k] };
}
function textoSol(ms, largo) {
  const s = posicionSol(new Date(ms), CENTRO[1], CENTRO[0]), alt = s.altG;
  const t = tiempoEn(ms);
  const tiempo = t ? ` · ${Math.round(t.t)} °C${t.uv >= 1 ? ` · UV ${Math.round(t.uv)}` : ''}` : '';
  if (alt < 2) return { noche: true, txt: `${hhmm(ms)} · Sin sol directo${tiempo}` };
  return { noche: false, txt: `${hhmm(ms)} · Sol ${Math.round(alt)}° ${cardinal(s.az)}${tiempo}`, alt, az: s.az, t };
}
function pintarSolChip() {
  const ms = instante(), s = textoSol(ms);
  const dia = estado.salida && partes(ms).d !== partes(Date.now()).d ? fechaLarga(ms) + ', ' : '';
  $('solchipTxt').textContent = dia + s.txt;
  $('solchip').classList.toggle('noche', s.noche);
  $('solchip').querySelector('use').setAttribute('href', s.noche ? '#i-luna' : '#i-sol');
}
$('solchip').addEventListener('click', () => abrirHora());
cargarMeteo().then(pintarSolChip);
setInterval(() => { if (estado.salida == null) { pintarSolChip(); if (!document.hidden) programarSombras(); } }, 60000);

// ------------------------------------------------------------------ ubicación
function prepararUbicacion() {
  const decidido = localStorage.getItem('pls_ubicacion');
  if (!('geolocation' in navigator)) return;
  const consulta = navigator.permissions?.query({ name: 'geolocation' }).catch(() => null) || Promise.resolve(null);
  consulta.then(p => {
    if (p?.state === 'granted') vigilarUbicacion(true);
    else if (p?.state === 'denied') return;
    else if (!decidido) $('dlgUbicacion').showModal();
  });
}
$('btnUbiSi').addEventListener('click', () => { $('dlgUbicacion').close(); localStorage.setItem('pls_ubicacion', 'si'); vigilarUbicacion(true); });
$('btnUbiNo').addEventListener('click', () => { $('dlgUbicacion').close(); localStorage.setItem('pls_ubicacion', 'no'); });

function vigilarUbicacion(centrar) {
  if (estado.vigilando != null) { if (centrar && estado.yo) irAYo(); return; }
  let primera = true;
  estado.vigilando = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    estado.yo = { lon: c.longitude, lat: c.latitude, prec: c.accuracy, rumbo: c.heading, vel: c.speed, t: p.timestamp };
    pintarYo();
    if (primera) {
      primera = false;
      if (centrar) irAYo();
      if (estado.destino && !estado.origen) { estado.origen = { tipo: 'yo', texto: 'Tu ubicación' }; $('qOrigen').value = 'Tu ubicación'; calcular(); }
    }
    if (estado.navegando) seguirNavegacion();
  }, err => {
    estado.vigilando = null;
    if (err.code === 1) {
      localStorage.setItem('pls_ubicacion', 'no');
      aviso('Has bloqueado la ubicación. Puedes activarla en los permisos del sitio (el candado junto a la dirección).', 7000);
    } else if (primera) aviso('No hemos podido saber dónde estás. Vuelve a probar en un momento.');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function dentroDeMarbella(p) {
  const b = estado.meta?.bbox;
  return b && p.lon >= b[0] - 0.01 && p.lon <= b[2] + 0.01 && p.lat >= b[1] - 0.01 && p.lat <= b[3] + 0.01;
}
function irAYo() {
  if (!estado.yo) return;
  if (!dentroDeMarbella(estado.yo)) { aviso('Estás fuera de Marbella: la app solo calcula rutas dentro del municipio.'); return; }
  mapa.easeTo({ center: [estado.yo.lon, estado.yo.lat], zoom: Math.max(mapa.getZoom(), 16.2), duration: 800 });
}
function pintarYo() {
  if (!mapa || !estado.yo) return;
  if (!marcaYo) {
    const el = document.createElement('div'); el.className = 'mk-yo'; el.innerHTML = '<span class="cono"></span>';
    marcaYo = new maplibregl.Marker({ element: el }).setLngLat([estado.yo.lon, estado.yo.lat]).addTo(mapa);
  }
  marcaYo.setLngLat([estado.yo.lon, estado.yo.lat]);
  const cono = marcaYo.getElement().querySelector('.cono');
  const r = estado.yo.rumbo;
  cono.style.display = r != null && !isNaN(r) && estado.yo.vel > 0.4 ? 'block' : 'none';
  if (r != null) cono.style.rotate = `${r - mapa.getBearing()}deg`;
}
$('btnUbicacion').addEventListener('click', () => {
  if (estado.yo) { irAYo(); return; }
  if (!('geolocation' in navigator)) return aviso('Este navegador no permite conocer la ubicación.');
  localStorage.setItem('pls_ubicacion', 'si');
  vigilarUbicacion(true);
});

// ------------------------------------------------------------------ capas
$('btnSombras').addEventListener('click', () => {
  estado.sombras = !estado.sombras;
  $('btnSombras').classList.toggle('activo', estado.sombras);
  $('btnSombras').setAttribute('aria-pressed', String(estado.sombras));
  ultimaSombra = null; programarSombras();
  aviso(estado.sombras ? 'Sombras visibles (a partir de un zoom de barrio)' : 'Sombras ocultas', 2000);
});
$('btnCapas').addEventListener('click', () => {
  estado.fondo = estado.fondo === 'mapa' ? 'orto' : 'mapa';
  mapa.setLayoutProperty('orto', 'visibility', estado.fondo === 'orto' ? 'visible' : 'none');
  $('btnCapas').classList.toggle('activo', estado.fondo === 'orto');
  aviso(estado.fondo === 'orto' ? 'Fondo: ortofoto del IGN' : 'Fondo: callejero', 1800);
});

// ------------------------------------------------------------------ buscador
let tBusca = null, abortBusca = null, sugActual = [], sugSel = -1;
const campos = { qDestino0: 'destino', qDestino: 'destino', qOrigen: 'origen' };
for (const id of Object.keys(campos)) {
  const inp = $(id);
  inp.addEventListener('focus', () => { estado.campo = id; inp.select(); sugerir(inp.value); });
  inp.addEventListener('input', () => { estado.campo = id; sugerir(inp.value); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugSel = Math.max(-1, Math.min(sugActual.length - 1, sugSel + (e.key === 'ArrowDown' ? 1 : -1)));
      document.querySelectorAll('.sug').forEach((el, i) => el.classList.toggle('sel', i === sugSel));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = sugActual[sugSel >= 0 ? sugSel : 0];
      if (s) elegirSugerencia(s);
    } else if (e.key === 'Escape') { cerrarSugerencias(); inp.blur(); }
  });
}
document.addEventListener('pointerdown', e => {
  if (!$('sugerencias').hidden && !e.target.closest('#sugerencias, .barra')) cerrarSugerencias();
});
function cerrarSugerencias() { $('sugerencias').hidden = true; sugActual = []; sugSel = -1; }

const ICO_CAT = { 'Calle': 'pin', 'Dirección': 'pin', 'Playa': 'sombrilla', 'Parque': 'arbol', 'Jardín': 'arbol', 'Zona': 'mira', 'Barrio': 'mira', 'Núcleo': 'mira' };
function sugerir(q) {
  clearTimeout(tBusca);
  abortBusca?.abort();
  const campo = campos[estado.campo];
  const ref = estado.yo && dentroDeMarbella(estado.yo) ? [estado.yo.lon, estado.yo.lat] : mapa ? mapa.getCenter().toArray() : CENTRO;
  const lista = [];
  const qn = B.normal(q);
  if (!qn) {
    if (campo === 'origen') lista.push({ especial: 'yo', texto: 'Tu ubicación', sub: estado.yo ? 'Donde estás ahora' : 'Pide permiso al navegador', ico: 'ubicacion', cls: 'yo' });
    lista.push({ especial: 'mapa', texto: 'Elegir en el mapa', sub: 'Pulsa en el mapa el punto exacto', ico: 'mira' });
    for (const s of ordenarSitios()) lista.push({ texto: s.nombre, sub: s.texto || etiquetaTipo(s.tipo), lon: s.lon, lat: s.lat, ico: s.tipo === 'casa' ? 'casa' : s.tipo === 'trabajo' ? 'trabajo' : 'estrella', cls: 'casa', grupo: 'Tus sitios' });
    for (const h of estado.historial.slice(0, 6)) lista.push({ texto: h.texto, sub: 'Reciente', lon: h.lon, lat: h.lat, ico: 'historial', grupo: 'Recientes' });
    return pintarSugerencias(lista);
  }
  for (const s of estado.sitios) if (B.normal(s.nombre).includes(qn) || B.normal(etiquetaTipo(s.tipo)).startsWith(qn))
    lista.push({ texto: s.nombre, sub: s.texto || etiquetaTipo(s.tipo), lon: s.lon, lat: s.lat, ico: s.tipo === 'casa' ? 'casa' : s.tipo === 'trabajo' ? 'trabajo' : 'estrella', cls: 'casa' });
  for (const r of B.buscarLocal(q, ref, 8)) lista.push({ ...r, ico: ICO_CAT[r.cat] || 'pin' });
  pintarSugerencias(lista, /\d/.test(q) || lista.length < 4);
  if (/\d/.test(q) || lista.length < 4) {
    tBusca = setTimeout(async () => {
      abortBusca = new AbortController();
      try {
        const extra = await B.buscarDirecciones(q, abortBusca.signal);
        const vistos = new Set(lista.map(x => B.normal(x.texto)));
        const mas = extra.filter(x => !vistos.has(B.normal(x.texto))).map(x => ({ ...x, ico: 'pin', grupo: 'Direcciones' }));
        pintarSugerencias(/\d/.test(q) ? [...mas, ...lista] : [...lista, ...mas]);
      } catch (e) { if (e.name !== 'AbortError') pintarSugerencias(lista); }
    }, 320);
  }
}
const etiquetaTipo = t => t === 'casa' ? 'Casa' : t === 'trabajo' ? 'Trabajo' : 'Favorito';
const ordenarSitios = () => [...estado.sitios].sort((a, b) => ['casa', 'trabajo', 'fav'].indexOf(a.tipo) - ['casa', 'trabajo', 'fav'].indexOf(b.tipo));

function pintarSugerencias(lista, buscando) {
  sugActual = lista; sugSel = -1;
  const caja = $('sugerencias');
  let grupo = null, h = '';
  lista.forEach((s, i) => {
    if (s.grupo && s.grupo !== grupo) { grupo = s.grupo; h += `<div class="sug-titulo">${esc(grupo)}</div>`; }
    h += `<button class="sug" type="button" data-i="${i}" role="option"><span class="ic ${s.cls || ''}">${ico(s.ico || 'pin', 's')}</span>
          <span class="tx"><span class="t1">${esc(s.texto)}</span><span class="t2">${esc(s.sub || '')}</span></span></button>`;
  });
  if (!lista.length) h = `<div class="sug-vacio">${buscando ? '<span class="rueda p"></span> Buscando direcciones…' : 'No encontramos ese sitio en Marbella.'}</div>`;
  caja.innerHTML = h;
  caja.hidden = false;
  caja.querySelectorAll('.sug').forEach(b => b.addEventListener('click', () => elegirSugerencia(sugActual[+b.dataset.i])));
}

function elegirSugerencia(s) {
  const campo = campos[estado.campo] || 'destino';
  cerrarSugerencias();
  document.activeElement?.blur();
  if (s.especial === 'mapa') {
    estado.eligiendoEnMapa = campo;
    aviso(`Pulsa en el mapa para elegir el ${campo === 'origen' ? 'punto de partida' : 'destino'}`, 3500);
    return;
  }
  if (s.especial === 'yo') {
    if (!estado.yo) { localStorage.setItem('pls_ubicacion', 'si'); vigilarUbicacion(false); }
    fijar('origen', { tipo: 'yo', texto: 'Tu ubicación' });
    return;
  }
  fijar(campo, { tipo: 'lugar', texto: s.texto, lon: s.lon, lat: s.lat });
}

// ------------------------------------------------------------------ origen, destino y modo ruta
function fijar(campo, p) {
  estado[campo] = p;
  if (campo === 'destino') {
    if (!estado.origen) {
      if (estado.yo && dentroDeMarbella(estado.yo)) estado.origen = { tipo: 'yo', texto: 'Tu ubicación' };
    }
    C.anotarDestino({ texto: p.texto, lon: p.lon, lat: p.lat }).then(() => C.listarHistorial()).then(h => { estado.historial = h; }).catch(() => {});
  }
  modoRuta(true);
  $('qOrigen').value = estado.origen?.texto || '';
  $('qDestino').value = estado.destino?.texto || '';
  pintarMarcas();
  if (!estado.origen) {
    pintarHoja(`<p class="nota" style="margin-top:4px">Elige desde dónde sales: tu ubicación, un sitio o un punto del mapa.</p>`);
    setTimeout(() => $('qOrigen').focus(), 50);
    return;
  }
  if (!estado.destino) { setTimeout(() => $('qDestino').focus(), 50); return; }
  calcular();
}
function modoRuta(si) {
  document.body.classList.toggle('modo-ruta', si);
  $('filaBusca').hidden = si; $('filaRuta').hidden = !si;
  if (!si) {
    estado.origen = estado.destino = null; estado.rutas = []; estado.res = null;
    $('qDestino0').value = '';
    pintarRutas(); pintarMarcas(); pintarInicio();
  }
}
$('btnCerrarRuta').addEventListener('click', () => modoRuta(false));
$('btnCambiar').addEventListener('click', () => {
  if (estado.destino?.tipo === 'yo' || !estado.origen) return;
  [estado.origen, estado.destino] = [estado.destino, estado.origen];
  $('qOrigen').value = estado.origen?.texto || ''; $('qDestino').value = estado.destino?.texto || '';
  pintarMarcas(); calcular();
});

function coords(p) { return p?.tipo === 'yo' ? (estado.yo ? [estado.yo.lon, estado.yo.lat] : null) : p ? [p.lon, p.lat] : null; }

function pintarMarcas() {
  if (!mapa) return;
  const o = estado.origen?.tipo === 'yo' ? null : coords(estado.origen), d = coords(estado.destino);
  if (o) {
    if (!marcaO) { const el = document.createElement('div'); el.className = 'mk-o'; marcaO = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(o).addTo(mapa); marcaO.on('dragend', () => arrastrado('origen', marcaO)); }
    marcaO.setLngLat(o);
  } else if (marcaO) { marcaO.remove(); marcaO = null; }
  if (d) {
    if (!marcaD) {
      const el = document.createElement('div'); el.className = 'mk-d';
      el.innerHTML = '<svg viewBox="0 0 34 44"><path d="M17 43s14-14.6 14-25A14 14 0 0 0 3 18c0 10.4 14 25 14 25Z" fill="#c93434" stroke="#fff" stroke-width="2"/><circle cx="17" cy="18" r="5.5" fill="#fff"/></svg>';
      marcaD = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' }).setLngLat(d).addTo(mapa);
      marcaD.on('dragend', () => arrastrado('destino', marcaD));
    }
    marcaD.setLngLat(d);
  } else if (marcaD) { marcaD.remove(); marcaD = null; }
}
async function arrastrado(campo, marca) {
  const { lng, lat } = marca.getLngLat();
  const nombre = await nombreDelPunto([lng, lat]);
  estado[campo] = { tipo: 'mapa', texto: nombre, lon: lng, lat };
  $(campo === 'origen' ? 'qOrigen' : 'qDestino').value = nombre;
  calcular();
}
async function nombreDelPunto(p) {
  try { const r = await motor('cercano', { punto: p, radio: 80 }); return r?.nombre ? `${r.nombre} (punto del mapa)` : 'Punto del mapa'; }
  catch { return 'Punto del mapa'; }
}

let popup = null;
async function alPulsarMapa(e) {
  if (estado.navegando) return;
  if (mapa.getLayer('rutas-alt') && mapa.queryRenderedFeatures(e.point, { layers: ['rutas-alt'] }).length) return;
  const p = [e.lngLat.lng, e.lngLat.lat];
  if (estado.eligiendoEnMapa) {
    const campo = estado.eligiendoEnMapa; estado.eligiendoEnMapa = null;
    fijar(campo, { tipo: 'mapa', texto: await nombreDelPunto(p), lon: p[0], lat: p[1] });
    return;
  }
  popup?.remove();
  const el = document.createElement('div');
  el.innerHTML = `<b id="popNombre">Punto del mapa</b><div class="botones"><button class="btn" type="button" data-a="destino">Ir aquí</button><button class="btn sec" type="button" data-a="origen">Salir de aquí</button></div>`;
  popup = new maplibregl.Popup({ className: 'popup-punto', closeButton: false, maxWidth: '280px' }).setLngLat(p).setDOMContent(el).addTo(mapa);
  const nombre = await nombreDelPunto(p);
  el.querySelector('#popNombre').textContent = nombre.replace(' (punto del mapa)', '');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    popup.remove();
    fijar(b.dataset.a, { tipo: 'mapa', texto: nombre, lon: p[0], lat: p[1] });
  }));
}

// ------------------------------------------------------------------ cálculo de rutas
let pedidoRuta = 0, ultimaEstadistica = '';
async function calcular() {
  const o = coords(estado.origen), d = coords(estado.destino);
  if (!d) return;
  if (!o) {
    if (estado.origen?.tipo === 'yo') pintarHoja(`<p class="nota" style="margin-top:4px"><span class="rueda p"></span> Esperando a saber dónde estás…</p>`);
    return;
  }
  if (distM(o, d) < 15) { pintarHoja('<p class="nota">El origen y el destino están en el mismo sitio.</p>'); return; }
  const yo = ++pedidoRuta;
  pintarHoja(`<p class="nota" style="margin-top:4px"><span class="rueda p"></span> Calculando la sombra de cada calle…</p>`);
  await arranque;
  const salida = instante();
  let r;
  try { r = await motor('ruta', { origen: o, destino: d, salida, opc: estado.prefs }); }
  catch (e) { if (yo === pedidoRuta) pintarHoja(`<p class="msg error">No se ha podido calcular la ruta: ${esc(e.message)}</p>`); return; }
  if (yo !== pedidoRuta) return;
  if (r.error) {
    const t = r.error === 'origen' ? 'El punto de partida queda lejos de cualquier calle de Marbella.'
      : r.error === 'destino' ? 'El destino queda lejos de cualquier calle de Marbella.'
        : 'No hemos encontrado un camino a pie entre esos dos puntos.';
    estado.rutas = []; pintarRutas(); pintarHoja(`<p class="msg error">${t}</p>`); return;
  }
  estado.res = { ...r, salida }; estado.rutas = r.rutas; estado.sel = 0;
  pintarRutas(true); pintarHojaRuta();
  if (!estado.salida) { ultimaSombra = null; programarSombras(); }
  // estadística anónima (una por destino y sesión)
  const clave = d.map(v => v.toFixed(4)).join();
  if (estado.perfil?.estadisticas && !r.sinSol && clave !== ultimaEstadistica) {
    ultimaEstadistica = clave;
    const p = partes(salida), a = r.rutas[0], c = r.rutas.find(x => x.tipo === 'corta') || a;
    C.anotarEstadistica({ fecha: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, mes: p.m, hora: p.h,
      dsem: new Date(salida).getUTCDay(), dist: Math.round(a.dist), sombra: Math.round(a.pct * 100), sol: Math.round(a.solM),
      dist_corta: Math.round(c.dist), sombra_corta: Math.round(c.pct * 100), sol_corta: Math.round(c.solM),
      min: Math.round(a.seg / 60), tipo: a.tipo }).catch(e => console.warn('Estadística:', e));
  }
}

function pintarRutas(encuadrar) {
  if (!mapa?.getSource('rutas')) return;
  const feats = [];
  estado.rutas.forEach((r, i) => {
    if (i === estado.sel) return;
    feats.push({ type: 'Feature', properties: { alt: 1, i }, geometry: { type: 'LineString', coordinates: r.puntos.map(p => [p[0], p[1]]) } });
  });
  const r = estado.rutas[estado.sel];
  if (r) {
    let tramo = null;
    for (const [lon, lat, v] of r.puntos) {
      const s = v >= 0.5 ? 1 : 0;
      if (!tramo || tramo.s !== s) {
        const ant = tramo?.c[tramo.c.length - 1];
        tramo = { s, c: ant ? [ant] : [] };
        feats.push({ type: 'Feature', properties: { alt: 0, s }, geometry: { type: 'LineString', coordinates: tramo.c } });
      }
      tramo.c.push([lon, lat]);
    }
    // conectores entre los puntos elegidos y la red
    const o = coords(estado.origen), d = coords(estado.destino), ini = r.puntos[0], fin = r.puntos[r.puntos.length - 1];
    if (o && ini && distM(o, ini) > 4) feats.push({ type: 'Feature', properties: { con: 1 }, geometry: { type: 'LineString', coordinates: [o, [ini[0], ini[1]]] } });
    if (d && fin && distM(d, fin) > 4) feats.push({ type: 'Feature', properties: { con: 1 }, geometry: { type: 'LineString', coordinates: [[fin[0], fin[1]], d] } });
  }
  mapa.getSource('rutas').setData({ type: 'FeatureCollection', features: feats.filter(f => f.geometry.coordinates.length >= 2) });
  if (encuadrar && r) encuadrarRuta(r);
}
function encuadrarRuta(r) {
  const b = new maplibregl.LngLatBounds();
  r.puntos.forEach(p => b.extend([p[0], p[1]]));
  [coords(estado.origen), coords(estado.destino)].forEach(p => p && b.extend(p));
  const ancho = innerWidth >= 900;
  mapa.fitBounds(b, { padding: ancho ? { top: 70, bottom: 50, left: 60, right: 80 } : { top: 170, bottom: 270, left: 40, right: 70 }, maxZoom: 17.5, duration: 700 });
}
function elegirRuta(i) {
  estado.sel = i; pintarRutas(false); pintarHojaRuta();
}

// ------------------------------------------------------------------ hoja
function pintarHoja(contenido, plegada = true) {
  $('hoja').hidden = false;
  $('hoja').classList.toggle('plegada', plegada);
  $('hojaIn').innerHTML = contenido;
}
$('asa').addEventListener('click', () => $('hoja').classList.toggle('plegada'));

function pintarInicio() {
  if (document.body.classList.contains('modo-ruta')) return;
  if (innerWidth < 900) { $('hoja').hidden = true; return; }
  const sitios = ordenarSitios().slice(0, 4).map((s, i) => `<button class="chip" type="button" data-s="${i}">${ico(s.tipo === 'casa' ? 'casa' : s.tipo === 'trabajo' ? 'trabajo' : 'estrella', 's')}${esc(s.nombre)}</button>`).join('');
  pintarHoja(`<div class="bienvenida">
    <h2>Ve por la sombra</h2>
    <p>Busca a dónde vas y te proponemos la ruta a pie con más sombra para la hora a la que sales, sin dar un rodeo absurdo. En el mapa ves la sombra de los edificios en cada momento.</p>
    ${sitios ? `<div class="atajos">${sitios}</div>` : ''}
    <div class="leyenda"><span class="ls"><i></i>Tramo a la sombra</span><span class="lo"><i></i>Tramo al sol</span></div>
  </div>`, false);
  $('hojaIn').querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
    const s = ordenarSitios()[+b.dataset.s];
    fijar('destino', { tipo: 'lugar', texto: s.nombre, lon: s.lon, lat: s.lat });
  }));
}

const NOMBRE_TIPO = { sombra: 'Más sombra', equilibrada: 'Equilibrada', corta: 'Más corta' };
function icoGiro(p) {
  if (p.fin) return 'meta';
  if (p.giro == null) return 'navegar';
  const a = Math.abs(p.giro), d = p.giro > 0;
  return a < 25 ? 'recto' : a < 60 ? (d ? 'lder' : 'lizq') : a < 150 ? (d ? 'der' : 'izq') : 'vuelta';
}
function pintarHojaRuta() {
  const res = estado.res, rs = estado.rutas;
  if (!res || !rs.length) return;
  const corta = rs.find(r => r.tipo === 'corta') || rs[rs.length - 1];
  const s = textoSol(res.salida);
  const cab = res.sinSol
    ? `<span class="solinfo">${ico('luna', 's')} A esa hora no hay sol directo: te damos la ruta más corta.</span>`
    : `<span class="solinfo">${ico('sol', 's')} Sales a las ${hhmm(res.salida)}${estado.salida && partes(res.salida).d !== partes(Date.now()).d ? ' del ' + fechaLarga(res.salida) : ''} · sol a ${Math.round(s.alt)}° desde ${rumbo(s.az)}${s.t ? ` · ${Math.round(s.t.t)} °C` : ''}</span>`;
  const alts = rs.map((r, i) => {
    const llegada = hhmm(res.salida + r.seg * 1000);
    const ahorro = corta.solM - r.solM, extra = r.seg - corta.seg;
    const gan = r.tipo !== 'corta' && ahorro > 0
      ? `<span class="ganancia">${fmtDist(ahorro)} menos al sol que la más corta${extra > 30 ? ` (+${fmtMin(extra)})` : ''}</span>` : '';
    return `<button class="alt ${i === estado.sel ? 'sel' : ''}" type="button" data-i="${i}">
      <span class="nom">${NOMBRE_TIPO[r.tipo] || 'Ruta'}${i === 0 && r.tipo === 'sombra' ? '<span class="tag">Recomendada</span>' : ''}</span>
      <span class="min">${fmtMin(r.seg)}<small>${fmtDist(r.dist)}</small></span>
      <span class="det">Llegas a las ${llegada}${r.subida > 8 ? ` · subes ${Math.round(r.subida)} m` : ''}${r.escalones ? ' · con escaleras' : ''}</span>
      ${res.sinSol ? '' : `<span class="barra-sombra medidor"><span class="pista"><i style="width:${Math.round(r.pct * 100)}%"></i></span><b>${pct(r.pct)} a la sombra</b></span>`}
      ${gan}
    </button>`;
  }).join('');
  const r = rs[estado.sel];
  const unica = rs.length === 1 && !res.sinSol
    ? `<p class="nota">La ruta más corta ya es la que más sombra tiene ahora mismo (o no hay otra con bastante más sombra dentro del rodeo que permites).</p>` : '';
  const pasos = r.instrucciones.map(p => `<li class="paso"><span class="gi">${ico(icoGiro(p), 's')}</span>
      <span class="tx">${esc(p.texto)}${p.acera ? `<span class="acera">acera ${p.acera}</span>` : ''}${p.m ? `<small>${fmtDist(p.m)}</small>` : ''}</span>
      <span class="pc ${p.pct == null ? '' : p.pct >= 0.5 ? 's' : 'o'}">${p.pct == null || res.sinSol ? '' : pct(p.pct) + '<br><small style="font-weight:500;color:var(--ink-mut)">sombra</small>'}</span></li>`).join('');
  pintarHoja(`<div class="cab-ruta">${cab}</div>
    <div class="alternativas">${alts}</div>
    ${unica}
    ${res.sinSol ? '' : '<div class="leyenda"><span class="ls"><i></i>A la sombra</span><span class="lo"><i></i>Al sol</span></div>'}
    <div class="acciones">
      <button class="btn" type="button" id="btnEmpezar">${ico('navegar', 's')} Empezar</button>
      <button class="btn sec" type="button" id="btnGuardar">${ico('estrella', 's')} Guardar</button>
    </div>
    <ol class="pasos">${pasos}</ol>
    <p class="nota">Sombra de los edificios del Catastro (3 m por planta) y de los árboles que hay en OpenStreetMap; no incluye toldos ni todo el arbolado. Se calcula con el sol que habrá en cada calle cuando pases por ella. Cálculo en ${res.ms} ms en tu dispositivo.</p>`,
    $('hoja').classList.contains('plegada'));
  $('hojaIn').querySelectorAll('.alt').forEach(b => b.addEventListener('click', () => elegirRuta(+b.dataset.i)));
  $('btnEmpezar').addEventListener('click', empezarNavegacion);
  $('btnGuardar').addEventListener('click', abrirGuardar);
}

// ------------------------------------------------------------------ hora de salida
function abrirHora() {
  const ms = instante(), p = partes(ms);
  $('horaDia').value = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  $('horaHora').value = `${String(p.h).padStart(2, '0')}:${String(p.min - p.min % 5).padStart(2, '0')}`;
  $('dlgHora').returnValue = '';
  $('dlgHora').showModal();
}
$('chipHora').addEventListener('click', abrirHora);
$('dlgHora').querySelectorAll('[data-hora]').forEach(b => b.addEventListener('click', () => {
  const v = b.dataset.hora;
  estado.salida = v === 'ahora' ? null : Date.now() + (+v) * 60000;
  $('dlgHora').close('cambio'); aplicarHora();
}));
$('dlgHora').addEventListener('close', () => {
  if ($('dlgHora').returnValue !== 'ok') return;
  const [y, m, d] = $('horaDia').value.split('-').map(Number), [h, mi] = ($('horaHora').value || '0:0').split(':').map(Number);
  if (!y || isNaN(h)) return;
  estado.salida = fechaMadrid(y, m, d, h, mi).valueOf();
  if (Math.abs(estado.salida - Date.now()) < 3 * 60000) estado.salida = null;
  aplicarHora();
});
function aplicarHora() {
  const ms = instante();
  $('chipHoraTxt').textContent = estado.salida == null ? 'Salir ahora'
    : (partes(ms).d !== partes(Date.now()).d ? `${fechaLarga(ms)}, ${hhmm(ms)}` : `Salir a las ${hhmm(ms)}`);
  $('chipHora').classList.toggle('on', estado.salida != null);
  if (ms - Date.now() > 15 * 86400000 || Date.now() - ms > 86400000) meteo = null;
  cargarMeteo().then(pintarSolChip);
  ultimaSombra = null; programarSombras(); pintarSolChip();
  if (estado.destino) calcular();
}

// ------------------------------------------------------------------ opciones de la ruta
function pintarChipAjustes() {
  const p = estado.prefs;
  $('chipAjustesTxt').textContent = `Rodeo ≤ ${Math.round(p.rodeo * 100)} %${p.escaleras ? '' : ' · sin escaleras'}`;
}
function marcarOpciones() {
  const p = estado.prefs;
  $('optRodeo').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', +b.dataset.v === p.rodeo));
  $('optVelocidad').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', +b.dataset.v === p.velocidad));
  $('optEscaleras').checked = !p.escaleras;
}
$('chipAjustes').addEventListener('click', () => { marcarOpciones(); $('dlgAjustes').showModal(); });
$('optRodeo').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { estado.prefs.rodeo = +b.dataset.v; marcarOpciones(); } });
$('optVelocidad').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { estado.prefs.velocidad = +b.dataset.v; marcarOpciones(); } });
$('optEscaleras').addEventListener('change', e => { estado.prefs.escaleras = !e.target.checked; });
$('dlgAjustes').addEventListener('close', () => {
  pintarChipAjustes();
  C.guardarPerfil({ prefs: estado.prefs }).catch(() => {});
  if (estado.destino) calcular();
});

// ------------------------------------------------------------------ guardar sitios
let tipoSitio = 'fav';
function abrirGuardar() {
  const d = estado.destino;
  if (!d) return;
  $('guardarTexto').textContent = d.texto;
  $('guardarNombre').value = d.texto.replace(' (punto del mapa)', '').slice(0, 60);
  tipoSitio = 'fav';
  $('optTipoSitio').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b.dataset.v === tipoSitio));
  $('dlgGuardar').returnValue = '';
  $('dlgGuardar').showModal();
}
$('optTipoSitio').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  tipoSitio = b.dataset.v;
  $('optTipoSitio').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
  if (tipoSitio !== 'fav') $('guardarNombre').value = etiquetaTipo(tipoSitio);
});
$('dlgGuardar').addEventListener('close', async () => {
  if ($('dlgGuardar').returnValue !== 'ok') return;
  const d = estado.destino;
  try {
    await C.guardarSitio({ nombre: $('guardarNombre').value.trim() || etiquetaTipo(tipoSitio), tipo: tipoSitio, texto: d.texto, lon: d.lon ?? coords(d)[0], lat: d.lat ?? coords(d)[1] });
    estado.sitios = await C.listarSitios();
    aviso('Sitio guardado');
  } catch (e) { aviso('No se ha podido guardar: ' + C.mensajeError(e)); }
});

// ------------------------------------------------------------------ perfil
$('btnPerfil').addEventListener('click', () => { pintarPerfil(); $('dlgPerfil').showModal(); });
$('dlgPerfil').querySelector('[data-cerrar]').addEventListener('click', () => $('dlgPerfil').close());
function pintarPerfil() {
  const l = ordenarSitios();
  $('listaSitios').innerHTML = l.map(s => `<li>${ico(s.tipo === 'casa' ? 'casa' : s.tipo === 'trabajo' ? 'trabajo' : 'estrella')}
    <span class="tx">${esc(s.nombre)}<small>${esc(s.texto || '')}</small></span>
    <button class="icono-btn" type="button" data-ir="${esc(s.id)}" aria-label="Ir a ${esc(s.nombre)}">${ico('navegar', 's')}</button>
    <button class="icono-btn" type="button" data-borrar="${esc(s.id)}" aria-label="Borrar ${esc(s.nombre)}">${ico('papelera', 's')}</button></li>`).join('');
  $('sitiosVacio').hidden = l.length > 0;
  $('optAnonimo').checked = !!estado.perfil?.estadisticas;
  const invitado = estado.usuario?.proveedor === 'invitado';
  $('optAnonimo').closest('.interruptor').hidden = invitado;
  $('btnSalir').lastChild.textContent = invitado ? 'Salir' : 'Cerrar sesión';
  $('btnTemaTxt').textContent = temaOscuro() ? 'Tema claro' : 'Tema oscuro';
  $('btnBorrarCuenta').dataset.confirmar = '';
  $('btnBorrarCuenta').lastChild.textContent = invitado ? 'Borrar mis datos de este navegador' : 'Eliminar mi cuenta';
}
$('listaSitios').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const s = estado.sitios.find(x => x.id === (b.dataset.ir || b.dataset.borrar));
  if (!s) return;
  if (b.dataset.ir) { $('dlgPerfil').close(); fijar('destino', { tipo: 'lugar', texto: s.nombre, lon: s.lon, lat: s.lat }); return; }
  await C.borrarSitio(s.id).catch(() => {});
  estado.sitios = await C.listarSitios().catch(() => estado.sitios.filter(x => x.id !== s.id));
  pintarPerfil();
});
$('optAnonimo').addEventListener('change', async e => {
  estado.perfil = { ...(estado.perfil || {}), estadisticas: e.target.checked };
  await C.guardarPerfil({ estadisticas: e.target.checked }).catch(() => aviso('No se ha podido guardar la preferencia.'));
});
$('btnTema').addEventListener('click', () => {
  const nuevo = temaOscuro() ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('pls_tema', nuevo); } catch { }
  $('btnTemaTxt').textContent = nuevo === 'dark' ? 'Tema claro' : 'Tema oscuro';
  if (mapa) mapa.setStyle(nuevo === 'dark' ? ESTILO.oscuro : ESTILO.claro);
});
$('btnSalir').addEventListener('click', async () => { $('dlgPerfil').close(); modoRuta(false); await C.salir(); });
$('btnBorrarCuenta').addEventListener('click', async () => {
  const b = $('btnBorrarCuenta');
  if (!b.dataset.confirmar) { b.dataset.confirmar = '1'; b.lastChild.textContent = 'Pulsa otra vez para borrarlo todo'; return; }
  try { await C.borrarCuenta(); $('dlgPerfil').close(); aviso('Tu cuenta y tus datos se han borrado.'); }
  catch (e) { aviso(C.mensajeError(e), 7000); }
});
try { const t = localStorage.getItem('pls_tema'); if (t) document.documentElement.dataset.theme = t; } catch { }

// ------------------------------------------------------------------ navegación
let nav = null, bloqueo = null;
async function empezarNavegacion() {
  const r = estado.rutas[estado.sel];
  if (!r) return;
  if (!estado.yo) {
    localStorage.setItem('pls_ubicacion', 'si'); vigilarUbicacion(false);
    aviso('Para seguir la ruta necesitamos tu ubicación. Acepta el permiso del navegador.', 5000);
    return;
  }
  // distancias acumuladas a lo largo de la línea y de los pasos
  const acum = [0];
  for (let k = 1; k < r.puntos.length; k++) acum.push(acum[k - 1] + distM(r.puntos[k - 1], r.puntos[k]));
  const totalPasos = r.instrucciones.reduce((a, p) => a + p.m, 0) || 1;
  let a = 0;
  const inicioPasos = r.instrucciones.map(p => { const v = a; a += p.m; return v / totalPasos * acum[acum.length - 1]; });
  nav = { r, acum, inicioPasos, total: acum[acum.length - 1], fuera: 0, salida: Date.now() };
  estado.navegando = true; estado.seguir = true;
  document.body.classList.add('navegando');
  $('navTop').hidden = $('navBot').hidden = false;
  try { bloqueo = await navigator.wakeLock?.request('screen'); } catch { }
  seguirNavegacion();
}
function seguirNavegacion() {
  if (!nav || !estado.yo) return;
  const yo = [estado.yo.lon, estado.yo.lat], r = nav.r;
  // punto de la ruta más cercano
  let mejor = Infinity, s = 0;
  for (let k = 1; k < r.puntos.length; k++) {
    const a = r.puntos[k - 1], b = r.puntos[k];
    const ax = (b[0] - a[0]) * 89590, ay = (b[1] - a[1]) * 110968, px = (yo[0] - a[0]) * 89590, py = (yo[1] - a[1]) * 110968;
    const l2 = ax * ax + ay * ay, u = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
    const d = Math.hypot(px - u * ax, py - u * ay);
    if (d < mejor) { mejor = d; s = nav.acum[k - 1] + u * Math.sqrt(l2); }
  }
  const resto = Math.max(0, nav.total - s);
  if (resto < 20) { aviso('Has llegado. ¡Buen paseo por la sombra!', 6000); terminarNavegacion(); return; }
  // fuera de la ruta: se recalcula desde donde estás
  if (mejor > Math.max(35, (estado.yo.prec || 0) * 0.8)) {
    if (++nav.fuera >= 3 && Date.now() - (nav.recalculo || 0) > 15000) {
      nav.recalculo = Date.now();
      aviso('Te has salido de la ruta: la recalculamos desde aquí.');
      estado.origen = { tipo: 'yo', texto: 'Tu ubicación' }; estado.salida = null;
      calcular().then(() => { if (estado.navegando) empezarNavegacion(); });
      return;
    }
  } else nav.fuera = 0;
  // siguiente indicación
  let i = 0;
  while (i + 1 < nav.inicioPasos.length && nav.inicioPasos[i + 1] <= s + 8) i++;
  const sig = r.instrucciones[Math.min(i + 1, r.instrucciones.length - 1)], hasta = (nav.inicioPasos[i + 1] ?? nav.total) - s;
  $('navDist').textContent = fmtDist(Math.max(0, hasta));
  $('navTxt').textContent = sig.texto;
  $('navIco').querySelector('use').setAttribute('href', '#i-' + icoGiro(sig));
  const actual = r.instrucciones[i];
  $('navAcera').hidden = !actual.acera;
  $('navAcera').textContent = actual.acera ? `Ve por la acera ${actual.acera}` : '';
  const quedaSeg = r.seg * resto / nav.total;
  $('navResto').textContent = fmtMin(quedaSeg);
  $('navResto2').textContent = `${fmtDist(resto)} · llegada ${hhmm(Date.now() + quedaSeg * 1000)}`;
  if (estado.seguir) mapa.easeTo({ center: yo, zoom: Math.max(mapa.getZoom(), 17.2), duration: 600 });
}
function terminarNavegacion() {
  estado.navegando = false; nav = null;
  document.body.classList.remove('navegando');
  $('navTop').hidden = $('navBot').hidden = true;
  bloqueo?.release?.().catch(() => {}); bloqueo = null;
}
$('btnFinNav').addEventListener('click', terminarNavegacion);
$('navTop').addEventListener('click', () => { estado.seguir = true; seguirNavegacion(); });
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && estado.navegando && !bloqueo) { try { bloqueo = await navigator.wakeLock?.request('screen'); } catch { } }
});

// ------------------------------------------------------------------ arranque
addEventListener('resize', () => { if (!document.body.classList.contains('modo-ruta')) pintarInicio(); });
(async () => {
  try {
    const ok = await C.iniciar();
    C.alCambiarUsuario(alCambiarUsuario);
    if (!ok && C.sinCuentaRecordado()) C.entrarSinCuenta();      // ya entró sin cuenta en este navegador
  } catch (e) {
    console.error(e);
    mostrarAcceso('form');
    msgAcceso('No se ha podido conectar con el servicio de cuentas. Revisa la conexión y recarga la página.');
  }
})();
