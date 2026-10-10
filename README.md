# Por la sombra · Marbella

Rutas a pie por Marbella que buscan la **sombra de los edificios** según el día y la hora a la que sales,
como un Google Maps de la sombra. Incluye el **Observatorio de la sombra** (`observatorio/`), con el % de
las aceras a la sombra a cada hora y en cada mes, por zonas y por calles.

- Registro **obligatorio** (Firebase Authentication: correo y contraseña con verificación, o Google).
- La ubicación se pide con el permiso del navegador y **no sale del móvil**: la ruta se calcula en el propio
  dispositivo (Web Worker), con los datos estáticos de `data/` (≈ 2,6 MB en total).
- Web: https://josehino.github.io/por-la-sombra/ (repo `JoseHino/por-la-sombra`, GitHub Pages).
  Observatorio: https://josehino.github.io/por-la-sombra/observatorio/

## Cómo funciona

1. **Sol**: posición del sol para cada instante (fórmulas de SunCalc, las mismas que el Gemelo Digital).
2. **Sombras** (`js/motor.js`): cada cuerpo de edificio del Catastro es un prisma (huella × altura =
   3 m por planta + 1 m); cada árbol de OpenStreetMap, un prisma "flotante" entre la base de la copa y la copa
   (palmeras con menos sombra). La sombra de un prisma es la suma de Minkowski de su huella y el segmento que
   recorre la sombra; se rasteriza a 1 m en teselas de 256 m, solo donde hace falta.
3. **Aceras**: en las calles sin aceras dibujadas aparte (casi todas en Marbella), se simulan las dos aceras
   a cada lado de la calzada según su ancho estimado (`width`, `lanes` o tipo de vía). Cada tramo se mide en el
   eje y en las dos aceras y se queda con la de más sombra; la ruta se dibuja por esa acera.
4. **Rutas**: A* sobre la red peatonal de OpenStreetMap con coste = metros a la sombra + (1 + β) × metros al
   sol, para varios β. La sombra de cada tramo se calcula con el sol de la hora a la que se llega a él (franjas
   de 10 min) y la velocidad tiene en cuenta la pendiente (función de Tobler, relieve del gemelo). Se ofrecen:
   **Más sombra** (la que menos sol tiene sin pasar del rodeo máximo, 30 % por defecto), **Equilibrada** (la
   que más sol ahorra por metro de rodeo) y **Más corta**. De noche, solo la más corta.
5. **Navegación**: sigue tu posición, dice la siguiente indicación y la acera, y recalcula si te sales.

## Archivos

| Qué | Dónde |
|---|---|
| App (acceso, mapa, buscador, rutas, navegación) | `index.html`, `css/app.css`, `js/app.js` |
| Motor (sol, sombras, red, A*, indicaciones) | `js/motor.js` (sin DOM; lo usan el worker y Node) y `js/worker.js` |
| Cuentas y datos de usuario (Firebase) | `js/cuentas.js`; configuración en `js/config.js`; reglas en `firestore.rules` |
| Buscador | `js/buscador.js`: índice propio (`data/buscador.json`) + CartoCiudad (direcciones con número) + Photon |
| Textos legales | `privacidad.html`, `aviso-legal.html` (rellenan el titular desde `js/config.js`) |
| Observatorio (kit de observatorios) | `observatorio/` (`app.js` declara las secciones; `uso.js` lee las estadísticas anónimas) |
| Datos | `data/red.bin.gz`, `edificios.bin.gz`, `vegetacion.bin.gz` (contenedor `PLS1`, ver `leerPLS`), `buscador.json`, `termino.geojson`, `meta.json` |
| Generación de datos | `scripts/extraer_osm.py` → `scripts/construir_datos.py` → `scripts/indicadores.mjs` |

## Actualización de los datos (GitHub Actions)

`.github/workflows/datos.yml`, el día 5 de cada mes y a mano (Actions → Datos → Run workflow):

1. `extraer_osm.py`: descarga el extracto de Andalucía de Geofabrik (~200 MB) y saca lo de Marbella (vías,
   árboles, masas arboladas, lugares, término). Va en dos pasadas: ensamblar áreas de toda Andalucía con
   `with_areas()` se comía más de 5 GB. Overpass falla a menudo y no se usa.
2. `construir_datos.py`: red peatonal (componente conexa mayor, cota de cada cruce), edificios del Catastro
   (ATOM INSPIRE 29069, unidos por referencia catastral y nº de plantas), vegetación y buscador. En local se
   pueden reutilizar el GML del gemelo (`CATASTRO_DIR`) y su relieve (`RELIEVE_PMTILES`).
3. `indicadores.mjs`: % de la red a la sombra para el día 15 de cada mes y cada hora, por zonas y por calles
   (`HILOS=2` para gastar menos memoria en local; ~1 min).

En local, con `CACHE_DIR` apuntando fuera de OneDrive para no sincronizar los ~200 MB del PBF.

## Firebase (pendiente de crear)

1. https://console.firebase.google.com → **Crear proyecto** (sin Google Analytics).
2. **Authentication** → Comenzar → activar **Correo electrónico/contraseña** y **Google**.
3. Authentication → Configuración → **Dominios autorizados** → añadir `josehino.github.io`.
4. **Firestore Database** → Crear base de datos → ubicación **europe-southwest1 (Madrid)** → modo producción.
5. Firestore → **Reglas** → pegar `firestore.rules` → Publicar.
6. Configuración del proyecto → Tus apps → **Web** → copiar `apiKey`, `authDomain`, `projectId`, `appId` a `js/config.js`.

Datos en Firestore: `usuarios/{uid}` (perfil, preferencias, aceptación de la privacidad), `usuarios/{uid}/sitios`
(casa, trabajo, favoritos), `usuarios/{uid}/historial` (20 últimos destinos) y `estadisticas` (anónimas: hora,
distancia y % de sombra; sin usuario, origen ni destino; solo con consentimiento).

Mientras `js/config.js` no tenga la configuración de Firebase, la app se usa **provisionalmente sin cuenta**
(botón "Entrar"; sitios, destinos y preferencias en el navegador). En cuanto se pega la configuración, el
registro pasa a ser obligatorio sin tocar nada más.

## Pendiente

- Titular: José María Hinojosa Figueira, a título personal (el Ayuntamiento no participa por ahora); contacto
  en `js/config.js` → `TITULAR` (NIF y domicilio opcionales, ocultos si están vacíos).
- Crear el proyecto de Firebase y pegar la configuración (hasta entonces, uso sin cuenta).
- Mejoras posibles: arbolado completo con el LiDAR del PNOA (MDS − MDT), toldos y soportales, relieve en las
  sombras, inventario municipal de arbolado si el Ayuntamiento lo publica.

## Probar en local

`npx http-server -c-1 -p 8791` en esta carpeta y abrir http://localhost:8791/. Ojo: el puerto 8765 lo usa
otro servidor del usuario.
