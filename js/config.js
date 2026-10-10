// Configuración de la web. Es lo único que hay que tocar para cambiar de proyecto de Firebase o de titular.

// Proyecto de Firebase (consola de Firebase > Configuración del proyecto > Tus apps > App web).
// Estos valores son públicos por diseño: la seguridad está en las reglas de Firestore (firestore.rules).
// Si apiKey está vacío, en local (localhost) se puede entrar en "modo de prueba" sin cuentas reales.
export const FIREBASE = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
};

// Responsable del tratamiento de los datos (política de privacidad y aviso legal).
// Proyecto personal y gratuito: NIF y domicilio no son obligatorios; si se rellenan, aparecen en los textos legales.
export const TITULAR = {
  nombre: 'José María Hinojosa Figueira',
  nif: '',
  direccion: '',
  email: 'josemariahf612@gmail.com',
};

// Versión de la política de privacidad que acepta cada usuario al registrarse.
export const VERSION_PRIVACIDAD = '2026-10-09';

// Preferencias por defecto de las rutas.
export const PREFERENCIAS = {
  rodeo: 0.3,          // la ruta con más sombra puede ser hasta un 30 % más larga que la más corta
  velocidad: 4.8,      // km/h en llano (la pendiente la corrige el motor)
  escaleras: true,     // permitir escaleras
};

// Centro del mapa al abrir (Alameda de Marbella) y punto de referencia del tiempo (Open-Meteo).
export const CENTRO = [-4.8858, 36.5098];
