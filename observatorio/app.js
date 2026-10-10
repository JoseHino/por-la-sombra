/* ============================================================================
   app.js — Observatorio de la sombra (Marbella).
   Los datos los calcula scripts/indicadores.mjs con el mismo motor que la app
   de rutas; el uso de la app (estadísticas anónimas) lo añade uso.js.
   ========================================================================== */
(function () {
  'use strict';

  var D = window.DATOS || {};
  var F = Obs.fmt;
  var M = D.meta || {};
  var HORAS = D.horas || [];
  var X_HORAS = HORAS.map(function (h) { return h + ':00'; });
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var MES_CORTO = D.meses || [];

  var red = D.red || [];
  var en = function (tabla, mes, hora) { var f = (tabla || [])[mes - 1]; var i = HORAS.indexOf(hora); return f && i >= 0 ? f[i] : null; };
  var pct0 = function (v) { return F.pct(v, 0); };

  var FUENTE = { txt: 'Modelo de Por la sombra (Catastro y OpenStreetMap)', url: '../aviso-legal.html' };
  var CHIP_MODELO = { txt: 'Modelo', tipo: 'brand' };
  var MOMENTOS = [
    { v: 'jul_15', txt: 'julio, 15:00', mes: 7, hora: 15 },
    { v: 'jul_12', txt: 'julio, 12:00', mes: 7, hora: 12 },
    { v: 'jul_18', txt: 'julio, 18:00', mes: 7, hora: 18 },
    { v: 'ene_13', txt: 'enero, 13:00', mes: 1, hora: 13 }
  ];
  var momento = function (v) { return MOMENTOS.filter(function (m) { return m.v === v; })[0] || MOMENTOS[0]; };
  var ICONO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M22 12a10 10 0 0 0-20 0Z"/><path d="M12 12v8a2 2 0 0 0 4 0M12 2v1"/></svg>';

  /* ---------------------------------------------------------------- zonas */
  var zonas = D.zonas || [];
  var porZona = function (v) {
    var mo = momento(v);
    var filas = zonas.map(function (z) { return { n: z.nombre, v: en(z.pct, mo.mes, mo.hora) }; })
      .filter(function (f) { return f.v != null; })
      .sort(function (a, b) { return b.v - a.v; });
    return { type: 'barh', x: filas.map(function (f) { return f.n; }), yFormat: pct0, unidad: '',
             series: [{ name: '% a la sombra (' + mo.txt + ')', data: filas.map(function (f) { return f.v; }) }] };
  };
  var curvaZona = function (nombre) {
    var z = zonas.filter(function (x) { return x.nombre === nombre; })[0] || zonas[0] || { pct: [] };
    return { type: 'line', xType: 'cat', x: X_HORAS, yFormat: pct0, desdeCero: true, yMax: 100,
             series: [{ name: z.nombre + ' · julio', data: z.pct[6] || [] }, { name: 'Toda la red · julio', data: red[6] || [] },
                      { name: z.nombre + ' · enero', data: z.pct[0] || [] }] };
  };

  /* ---------------------------------------------------------------- calles */
  var calles = (D.calles || []).filter(function (c) { return c.m >= 400; });
  var nombreCalle = function (c) { return c.nombre + (c.zona ? ' · ' + c.zona : ''); };
  var ranking = function (v, soleadas) {
    var l = calles.slice().sort(function (a, b) { return soleadas ? a[v] - b[v] || b.m - a.m : b[v] - a[v] || b.m - a.m; }).slice(0, 15);
    return { type: 'barh', x: l.map(nombreCalle), yFormat: pct0,
             series: [{ name: '% a la sombra (' + momento(v).txt + ')', data: l.map(function (c) { return c[v]; }) }] };
  };
  var ctrlMomento = function (spec) {
    return { label: 'Momento', valor: 'jul_15', opciones: MOMENTOS.map(function (m) { return { v: m.v, txt: m.txt }; }), spec: spec };
  };

  /* ------------------------------------------------------------- secciones */
  var SECCIONES = [
    {
      id: 'sombra', nombre: 'Sombra en las aceras',
      titulo: 'Cuánta sombra tienen las aceras de Marbella',
      desc: 'Parte de la red peatonal que queda a la sombra de los edificios del Catastro y del arbolado registrado en OpenStreetMap, ' +
        'a cada hora en punto del día 15 de cada mes. En las calles con acera cuenta la acera con más sombra, que es la que elegiría ' +
        'quien la busca. Es un modelo: la altura sale del número de plantas (3 m por planta y 1 m más) y no incluye toldos, relieve ni ' +
        'todo el arbolado, así que la sombra real en calles con mucho arbolado es mayor.',
      render: function () {
        var sol = D.horas_sol || [];
        return {
          hero: {
            valor: en(red, 7, 15), label: 'de la red peatonal a la sombra un día de julio a las 15:00', formato: pct0,
            extra: [
              { label: 'Horas de sol directo en una acera media en julio', valor: sol[6], formato: function (v) { return F.num(v, 1) + ' h'; } },
              { label: 'Kilómetros de red peatonal analizados', valor: M.km_red, formato: F.num },
              { label: 'Cuerpos de edificio que dan sombra', valor: M.edificios, formato: F.num }
            ]
          },
          kpis: [
            { label: 'Julio a las 12:00', valor: en(red, 7, 12), unidad: '%', dec: 0 },
            { label: 'Julio a las 18:00', valor: en(red, 7, 18), unidad: '%', dec: 0 },
            { label: 'Agosto a las 16:00', valor: en(red, 8, 16), unidad: '%', dec: 0 },
            { label: 'Enero a las 13:00', valor: en(red, 1, 13), unidad: '%', dec: 0 }
          ],
          cards: [
            {
              titulo: 'Aceras a la sombra según la hora', sub: 'Día 15 de enero, abril, julio y octubre · hora de Marbella',
              chips: [CHIP_MODELO], fuente: FUENTE, ancho: 'full',
              nota: 'Las horas sin sol directo (antes de salir o después de ponerse) no se dibujan.',
              spec: { type: 'line', xType: 'cat', x: X_HORAS, yFormat: pct0, desdeCero: true, yMax: 100, xTodas: true,
                      series: [{ name: 'Enero', data: red[0] }, { name: 'Abril', data: red[3] },
                               { name: 'Julio', data: red[6] }, { name: 'Octubre', data: red[9] }] }
            },
            {
              titulo: 'Un día cualquiera, hora a hora', sub: 'Parte de la red a la sombra el día 15 del mes elegido',
              chips: [CHIP_MODELO], fuente: FUENTE,
              control: { label: 'Mes', valor: '7', opciones: MESES.map(function (m, i) { return { v: String(i + 1), txt: m }; }),
                         spec: function (v) { return { type: 'bar', xType: 'cat', x: X_HORAS, yFormat: pct0, yMax: 100,
                                                       series: [{ name: '% a la sombra', data: red[+v - 1] || [] }] }; } },
              spec: { type: 'bar', xType: 'cat', x: X_HORAS, yFormat: pct0, yMax: 100, series: [{ name: '% a la sombra', data: red[6] || [] }] }
            },
            {
              titulo: 'Horas de sol directo en una acera media', sub: 'Suma, del amanecer al anochecer, de la parte de la acera al sol',
              chips: [CHIP_MODELO], fuente: FUENTE,
              spec: { type: 'bar', xType: 'cat', x: MES_CORTO, yFormat: 'dec1', unidad: 'h', xTodas: true,
                      series: [{ name: 'Horas de sol', data: sol }] }
            }
          ]
        };
      }
    },
    {
      id: 'zonas', nombre: 'Por zonas',
      titulo: 'La sombra por zonas',
      desc: 'Cada tramo de calle se asigna al núcleo o la zona de OpenStreetMap más cercana (Marbella centro, San Pedro, Nueva Andalucía, ' +
        'Las Chapas…). Solo se muestran las zonas con al menos 15 km de red. Las zonas de casco urbano denso, con calles estrechas y ' +
        'edificios altos, dan mucha más sombra que las urbanizaciones de casas bajas.',
      render: function () {
        return {
          cards: [
            { titulo: 'Zonas ordenadas por sombra', sub: 'Parte de la red de cada zona a la sombra', chips: [CHIP_MODELO], fuente: FUENTE,
              alto: 'tall', control: ctrlMomento(porZona), spec: porZona('jul_15') },
            { titulo: 'Una zona a lo largo del día', sub: 'Día 15 de julio y de enero, frente al conjunto de la red', chips: [CHIP_MODELO], fuente: FUENTE,
              alto: 'tall',
              control: { label: 'Zona', valor: (zonas[0] || {}).nombre, opciones: zonas.map(function (z) { return { v: z.nombre, txt: z.nombre + ' (' + z.km + ' km)' }; }), spec: curvaZona },
              spec: curvaZona((zonas[0] || {}).nombre) }
          ]
        };
      }
    },
    {
      id: 'calles', nombre: 'Calles',
      titulo: 'Las calles más soleadas y las más sombreadas',
      desc: 'Calles con nombre y al menos 400 m de recorrido en una misma zona. Las más soleadas en las horas de calor son las primeras ' +
        'candidatas a arbolado, toldos o pérgolas; las más sombreadas, buenas alternativas para pasear en verano.',
      render: function () {
        return {
          cards: [
            { titulo: 'Las 15 más soleadas', sub: 'Menor parte del recorrido a la sombra', chips: [CHIP_MODELO], fuente: FUENTE, alto: 'tall',
              control: ctrlMomento(function (v) { return ranking(v, true); }), spec: ranking('jul_15', true) },
            { titulo: 'Las 15 con más sombra', sub: 'Mayor parte del recorrido a la sombra', chips: [CHIP_MODELO], fuente: FUENTE, alto: 'tall',
              control: ctrlMomento(function (v) { return ranking(v, false); }), spec: ranking('jul_15', false) }
          ]
        };
      }
    },
    {
      id: 'uso', nombre: 'Uso de la app',
      titulo: 'Cómo se usa Por la sombra',
      desc: 'Estadísticas anónimas de las rutas que piden las personas que han aceptado compartirlas: hora, distancia y parte del ' +
        'camino a la sombra de la ruta recomendada y de la más corta. Nunca el origen ni el destino.',
      render: function () {
        var u = D.uso;
        if (!u) {
          return { nota: window.USO_ESTADO === 'cargando' ? 'Cargando las estadísticas de uso…'
            : window.USO_ESTADO === 'sin_registro' ? 'Las estadísticas de uso aparecerán cuando se active el registro de usuarios de <a href="../">Por la sombra</a>.'
            : 'Las estadísticas de uso se ven con la sesión iniciada en <a href="../">Por la sombra</a>. ' +
              'Si acabas de entrar, vuelve a esta página.' };
        }
        if (!u.total) return { nota: 'Todavía no hay rutas registradas en las estadísticas anónimas.' };
        return {
          hero: { valor: u.total, label: 'rutas calculadas', formato: F.num,
                  extra: [{ label: 'Metros al sol evitados frente a la ruta más corta', valor: u.solEvitado, formato: F.num }] },
          kpis: [
            { label: 'Sombra media en la ruta recomendada', valor: u.sombra, unidad: '%', dec: 0 },
            { label: 'Sombra media en la ruta más corta', valor: u.sombraCorta, unidad: '%', dec: 0 }
          ],
          cards: [
            { titulo: 'Rutas por hora de salida', sub: 'Hora de Marbella', chips: [{ txt: 'Uso', tipo: 'live' }],
              fuente: { txt: 'Estadísticas anónimas de Por la sombra', url: '../privacidad.html' }, ancho: 'full',
              spec: { type: 'bar', xType: 'cat', x: u.porHora.map(function (_, h) { return h + ':00'; }), yFormat: 'num',
                      series: [{ name: 'Rutas', data: u.porHora }] } }
          ]
        };
      }
    }
  ];

  Obs.init({
    titulo: 'Observatorio de la sombra · Marbella',
    subtitulo: 'Cuánta sombra dan los edificios y los árboles a las aceras, hora a hora',
    icono: ICONO,
    secciones: SECCIONES,
    actualizado: M.generado,
    controles: '<a class="obs-btn primary" href="../">Calcular una ruta por la sombra</a>',
    fuentes: [
      { txt: 'Catastro · INSPIRE Buildings', url: 'https://www.catastro.hacienda.gob.es/webinspire/index.html' },
      { txt: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
      { txt: 'Posición del sol: fórmulas de SunCalc', url: 'https://github.com/mourner/suncalc' }
    ],
    metodologia: 'Para cada instante se calcula la posición del sol y se proyecta la sombra de cada cuerpo de edificio del Catastro ' +
      '(un prisma con su huella y su altura) y de cada árbol de OpenStreetMap sobre el suelo, a 1 m de resolución. Después se mide ' +
      'qué parte de cada tramo de la red peatonal cae en sombra, cada 4 m, en el eje y en las dos aceras; en cada tramo cuenta la acera ' +
      'con más sombra. El cálculo es el mismo que usa la app para elegir las rutas (<code>scripts/indicadores.mjs</code>).',
    pie: 'Es un modelo orientativo. No tiene en cuenta el relieve, los toldos ni el arbolado que no está en OpenStreetMap, y la altura ' +
      'de los edificios se estima a partir de su número de plantas.'
  });
})();
