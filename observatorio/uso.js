// Uso de la app: agregados de las estadísticas anónimas de Firestore (solo con la sesión iniciada en
// Por la sombra; la sesión de Firebase se comparte entre las páginas de la misma web).
import * as C from '../js/cuentas.js';

const pinta = () => { try { Obs.refrescar('uso'); } catch { /* el panel aún no está montado */ } };

(async () => {
  try {
    if (!(await C.iniciar())) { window.USO_ESTADO = 'sin_registro'; pinta(); return; }
    C.alCambiarUsuario(async u => {
      window.DATOS = window.DATOS || {};
      if (!u || !u.verificado) { window.USO_ESTADO = null; window.DATOS.uso = null; pinta(); return; }
      window.USO_ESTADO = 'cargando'; pinta();
      try { window.DATOS.uso = await C.agregadosUso(); window.USO_ESTADO = 'ok'; }
      catch (e) { console.warn('Uso de la app:', e); window.USO_ESTADO = null; }
      pinta();
    });
  } catch (e) { console.warn('Uso de la app:', e); }
})();
