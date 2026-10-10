// Service worker de Por la sombra: hace la app instalable y guarda en el móvil la app y los datos.
// Ojo: todas las webs de josehino.github.io comparten origen, así que las cachés llevan el prefijo
// "por-la-sombra-" y solo se borran las propias. Lo que viene de otros dominios (mapa, fuentes,
// Firebase, tiempo, geocodificadores) no se toca: lo gestiona el navegador.
const PREFIJO = 'por-la-sombra-';
const CACHE = PREFIJO + 'v1';
const BASICOS = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/motor.js', 'js/worker.js', 'js/config.js',
                 'js/cuentas.js', 'js/buscador.js', 'manifest.webmanifest', 'img/icono.svg', 'img/icono-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIJO) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// datos versionados (?v=fecha): primero la caché, que no cambian
async function primeroCache(req) {
  const c = await caches.open(CACHE);
  const r = await c.match(req);
  if (r) return r;
  const n = await fetch(req);
  if (n.ok) c.put(req, n.clone());
  return n;
}

// el resto: primero la red (las mejoras llegan enseguida); sin red o si tarda más de 4 s, lo guardado
async function primeroRed(req) {
  const c = await caches.open(CACHE);
  const guardada = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
  const red = fetch(req).then(n => { if (n.ok) c.put(req, n.clone()); return n; });
  if (!guardada) return red;
  const espera = new Promise(ok => setTimeout(() => ok(guardada), 4000));
  return Promise.race([red.catch(() => guardada), espera]);
}

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL('./', location.href).pathname)) return;
  if (/\/data\/[^/]+$/.test(u.pathname) && u.searchParams.has('v')) e.respondWith(primeroCache(req));
  else e.respondWith(primeroRed(req));
});
