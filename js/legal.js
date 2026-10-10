// Rellena los datos del titular en las páginas legales (vienen de js/config.js).
import { TITULAR, VERSION_PRIVACIDAD } from './config.js';
// los bloques opcionales (NIF, domicilio) se ocultan si están vacíos
for (const el of document.querySelectorAll('[data-bloque]')) el.hidden = !TITULAR[el.dataset.bloque];
// los bloques opcionales (NIF, domicilio) se ocultan si están vacíos
for (const el of document.querySelectorAll('[data-bloque]')) el.hidden = !TITULAR[el.dataset.bloque];
for (const el of document.querySelectorAll('[data-titular]')) {
  const v = TITULAR[el.dataset.titular] || '';
  el.textContent = v;
  if (/^\[/.test(v)) el.classList.add('pendiente');
}
for (const el of document.querySelectorAll('[data-version]')) el.textContent = VERSION_PRIVACIDAD;
try { const t = localStorage.getItem('pls_tema'); if (t) document.documentElement.dataset.theme = t; } catch { /* sin almacenamiento */ }
