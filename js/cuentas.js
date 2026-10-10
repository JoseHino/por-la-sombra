// Cuentas de usuario (Firebase Authentication) y datos de cada usuario (Cloud Firestore).
// Si js/config.js no tiene proyecto de Firebase, la app se usa provisionalmente sin cuenta y guarda
// todo en el navegador; en cuanto se pone la configuración, el registro pasa a ser obligatorio.
import { FIREBASE, VERSION_PRIVACIDAD } from './config.js';

const V = '12.19.0';                       // versión del SDK de Firebase (gstatic)
export const configurado = !!FIREBASE.apiKey;

let A, Fs, auth, db;                        // módulos e instancias de Firebase
let prueba = null;                          // usuario del modo de prueba
const oyentes = new Set();

const MENSAJES = {
  'auth/invalid-credential': 'El correo o la contraseña no son correctos.',
  'auth/wrong-password': 'El correo o la contraseña no son correctos.',
  'auth/user-not-found': 'No hay ninguna cuenta con ese correo.',
  'auth/email-already-in-use': 'Ya hay una cuenta con ese correo. Prueba a entrar.',
  'auth/invalid-email': 'Ese correo no parece válido.',
  'auth/weak-password': 'La contraseña debe tener al menos 8 caracteres.',
  'auth/missing-password': 'Escribe la contraseña.',
  'auth/too-many-requests': 'Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.',
  'auth/network-request-failed': 'No hay conexión. Revisa la red y vuelve a probar.',
  'auth/popup-blocked': 'El navegador ha bloqueado la ventana de Google. Permite las ventanas emergentes de esta web.',
  'auth/requires-recent-login': 'Por seguridad, cierra sesión, vuelve a entrar y repite la operación.',
  'auth/user-disabled': 'Esta cuenta está desactivada.',
  'auth/operation-not-allowed': 'Este método de acceso no está activado.',
  'auth/account-exists-with-different-credential': 'Ese correo ya está registrado con otro método de acceso.',
};
export const mensajeError = e => MENSAJES[e?.code] || (e?.message ? `No se ha podido completar: ${e.message}` : 'Ha fallado algo. Vuelve a probar.');
const silencioso = e => ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e?.code);

// usuario en un formato propio (igual en Firebase y en el modo de prueba)
const aUsuario = u => u && ({
  uid: u.uid, email: u.email || '', nombre: u.displayName || (u.email || '').split('@')[0],
  foto: u.photoURL || null, verificado: !!u.emailVerified,
  proveedor: (u.providerData?.[0]?.providerId) || 'password',
});

export async function iniciar() {
  if (!configurado) return false;
  const base = `https://www.gstatic.com/firebasejs/${V}/`;
  const [app, a, fs] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  A = a; Fs = fs;
  const fbApp = app.initializeApp(FIREBASE);
  auth = A.getAuth(fbApp);
  auth.languageCode = 'es';
  db = Fs.getFirestore(fbApp);
  A.onAuthStateChanged(auth, u => oyentes.forEach(f => f(aUsuario(u))));
  return true;
}

export function alCambiarUsuario(f) {
  oyentes.add(f);
  if (!configurado) f(prueba);
}

// ------------------------------------------------------------------ acceso
export async function entrarGoogle() {
  try {
    const r = await A.signInWithPopup(auth, new A.GoogleAuthProvider());
    await asegurarPerfil(aUsuario(r.user), {});
  } catch (e) { if (!silencioso(e)) throw e; }
}
export async function entrarCorreo(email, clave) {
  await A.signInWithEmailAndPassword(auth, email.trim(), clave);
}
export async function crearCuenta(nombre, email, clave, anonimo) {
  if ((clave || '').length < 8) throw { code: 'auth/weak-password' };
  const r = await A.createUserWithEmailAndPassword(auth, email.trim(), clave);
  if (nombre) await A.updateProfile(r.user, { displayName: nombre.trim() });
  await asegurarPerfil({ ...aUsuario(r.user), nombre: nombre?.trim() || aUsuario(r.user).nombre }, { estadisticas: !!anonimo });
  await A.sendEmailVerification(r.user, { url: location.origin + location.pathname });
}
export const recordarClave = email => A.sendPasswordResetEmail(auth, email.trim(), { url: location.origin + location.pathname });
export const reenviarVerificacion = () => A.sendEmailVerification(auth.currentUser, { url: location.origin + location.pathname });
export async function recargar() {
  if (!configurado) return prueba;
  await auth.currentUser?.reload();
  const u = aUsuario(auth.currentUser);
  if (u?.verificado) oyentes.forEach(f => f(u));
  return u;
}
export async function salir() {
  if (!configurado) {
    prueba = null;
    try { localStorage.removeItem('pls_sin_cuenta'); } catch { /* sin almacenamiento */ }
    oyentes.forEach(f => f(null)); return;
  }
  await A.signOut(auth);
}
// uso provisional sin cuenta (mientras no haya proyecto de Firebase): todo se guarda en el navegador
export function entrarSinCuenta() {
  prueba = { uid: 'invitado', email: '', nombre: 'Sin cuenta', foto: null, verificado: true, proveedor: 'invitado' };
  oyentes.forEach(f => f(prueba));
}
export const sinCuentaRecordado = () => { try { return localStorage.getItem('pls_sin_cuenta') === '1'; } catch { return false; } };

// ------------------------------------------------------------------ almacenamiento (Firestore o el navegador)
const L = {
  leer(k, d) { try { return JSON.parse(localStorage.getItem('pls_' + k)) ?? d; } catch { return d; } },
  escribir(k, v) { try { localStorage.setItem('pls_' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const uid = () => configurado ? auth.currentUser?.uid : prueba?.uid;

export async function asegurarPerfil(u, extra) {
  if (!configurado) {
    const p = L.leer('perfil', null);
    if (!p) L.escribir('perfil', { nombre: u.nombre, email: u.email, estadisticas: false, prefs: {}, ...extra });
    return;
  }
  const ref = Fs.doc(db, 'usuarios', u.uid);
  const s = await Fs.getDoc(ref);
  if (!s.exists()) {
    await Fs.setDoc(ref, {
      nombre: (u.nombre || '').slice(0, 80), email: u.email, creado: Fs.serverTimestamp(), actualizado: Fs.serverTimestamp(),
      privacidad: { version: VERSION_PRIVACIDAD, fecha: Fs.serverTimestamp() }, estadisticas: false, prefs: {}, ...extra,
    });
  }
}
export async function leerPerfil() {
  if (!configurado) return L.leer('perfil', { estadisticas: false, prefs: {} });
  const s = await Fs.getDoc(Fs.doc(db, 'usuarios', uid()));
  return s.exists() ? s.data() : { estadisticas: false, prefs: {} };
}
export async function guardarPerfil(campos) {
  if (!configurado) { L.escribir('perfil', { ...L.leer('perfil', {}), ...campos }); return; }
  await Fs.setDoc(Fs.doc(db, 'usuarios', uid()), { ...campos, actualizado: Fs.serverTimestamp() }, { merge: true });
}

// sitios guardados: casa y trabajo tienen id fijo (solo uno de cada); los favoritos, id automático
export async function listarSitios() {
  if (!configurado) return L.leer('sitios', []);
  const q = await Fs.getDocs(Fs.collection(db, 'usuarios', uid(), 'sitios'));
  return q.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function guardarSitio(s) {
  const datos = { nombre: s.nombre.slice(0, 60), tipo: s.tipo, texto: (s.texto || '').slice(0, 120), lon: +s.lon, lat: +s.lat };
  if (!configurado) {
    const l = L.leer('sitios', []).filter(x => !(s.tipo !== 'fav' && x.tipo === s.tipo));
    l.push({ id: s.tipo !== 'fav' ? s.tipo : 'f' + Date.now(), ...datos });
    L.escribir('sitios', l); return;
  }
  const col = Fs.collection(db, 'usuarios', uid(), 'sitios');
  if (s.tipo === 'fav') await Fs.addDoc(col, { ...datos, creado: Fs.serverTimestamp() });
  else await Fs.setDoc(Fs.doc(col, s.tipo), { ...datos, creado: Fs.serverTimestamp() });
}
export async function borrarSitio(id) {
  if (!configurado) { L.escribir('sitios', L.leer('sitios', []).filter(x => x.id !== id)); return; }
  await Fs.deleteDoc(Fs.doc(db, 'usuarios', uid(), 'sitios', id));
}

// últimos destinos (se guardan como máximo 20)
export async function listarHistorial() {
  if (!configurado) return L.leer('historial', []);
  const q = await Fs.getDocs(Fs.query(Fs.collection(db, 'usuarios', uid(), 'historial'), Fs.orderBy('fecha', 'desc'), Fs.limit(20)));
  return q.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function anotarDestino(d) {
  const datos = { texto: (d.texto || '').slice(0, 120), lon: +d.lon, lat: +d.lat };
  const clave = `${datos.lon.toFixed(4)},${datos.lat.toFixed(4)}`;
  if (!configurado) {
    const l = L.leer('historial', []).filter(x => `${(+x.lon).toFixed(4)},${(+x.lat).toFixed(4)}` !== clave);
    l.unshift({ id: 'h' + Date.now(), ...datos, fecha: Date.now() });
    L.escribir('historial', l.slice(0, 20)); return;
  }
  // un documento por destino (id = coordenadas redondeadas): repetir un destino solo actualiza la fecha
  const col = Fs.collection(db, 'usuarios', uid(), 'historial');
  await Fs.setDoc(Fs.doc(col, clave.replace(/[^0-9.,-]/g, '')), { ...datos, fecha: Fs.serverTimestamp() });
  const q = await Fs.getDocs(Fs.query(col, Fs.orderBy('fecha', 'desc')));
  await Promise.all(q.docs.slice(20).map(x => Fs.deleteDoc(x.ref)));
}

// estadística anónima de una ruta (sin usuario, sin origen ni destino)
export async function anotarEstadistica(e) {
  if (!configurado) { const l = L.leer('estadisticas', []); l.push({ ...e, ts: Date.now() }); L.escribir('estadisticas', l.slice(-200)); return; }
  await Fs.addDoc(Fs.collection(db, 'estadisticas'), { ...e, v: 1, ts: Fs.serverTimestamp() });
}

// borra los datos del usuario y su cuenta
export async function borrarCuenta() {
  if (!configurado) { ['perfil', 'sitios', 'historial'].forEach(k => localStorage.removeItem('pls_' + k)); await salir(); return; }
  const u = uid();
  for (const c of ['sitios', 'historial']) {
    const q = await Fs.getDocs(Fs.collection(db, 'usuarios', u, c));
    await Promise.all(q.docs.map(d => Fs.deleteDoc(d.ref)));
  }
  await Fs.deleteDoc(Fs.doc(db, 'usuarios', u));
  await A.deleteUser(auth.currentUser);
}

// ------------------------------------------------------------------ observatorio: agregados de las estadísticas
export async function agregadosUso() {
  if (!configurado) {
    const l = L.leer('estadisticas', []);
    return { total: l.length, porHora: Array.from({ length: 24 }, (_, h) => l.filter(x => x.hora === h).length),
             sombra: l.length ? l.reduce((a, x) => a + x.sombra, 0) / l.length : null,
             sombraCorta: l.length ? l.reduce((a, x) => a + x.sombra_corta, 0) / l.length : null,
             solEvitado: l.reduce((a, x) => a + Math.max(0, x.sol_corta - x.sol), 0) };
  }
  const col = Fs.collection(db, 'estadisticas');
  const g = await Fs.getAggregateFromServer(col, { total: Fs.count(), sombra: Fs.average('sombra'), sombraCorta: Fs.average('sombra_corta'),
                                                   sol: Fs.sum('sol'), solCorta: Fs.sum('sol_corta') });
  const d = g.data();
  const porHora = await Promise.all(Array.from({ length: 24 }, (_, h) =>
    Fs.getCountFromServer(Fs.query(col, Fs.where('hora', '==', h))).then(r => r.data().count)));
  return { total: d.total, porHora, sombra: d.sombra, sombraCorta: d.sombraCorta, solEvitado: Math.max(0, (d.solCorta || 0) - (d.sol || 0)) };
}
