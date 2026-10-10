/* ============================================================================
   obs-ui.js — Armazón de los Observatorios de Indicadores
   ----------------------------------------------------------------------------
   Un observatorio se DECLARA (secciones, KPI, tarjetas) y este fichero lo monta:
   cabecera, pestañas, fichas, tarjetas-gráfica, vista de tabla, exportación,
   tema claro/oscuro, estado de actualización y pie metodológico.

   Regla del kit: ningún onclick en el HTML. Todo se engancha con
   addEventListener (las extensiones del navegador eliminan los onclick inline).
   ========================================================================== */
(function (global) {
  'use strict';

  var Obs = global.Obs = global.Obs || {};
  var CFG = null;
  var pintadas = {};        // secciones ya renderizadas (render perezoso)

  /* ------------------------------------------------------------- 1. Iconos */
  var I = Obs.icono = {
    _s: function (d, extra) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + d + '</svg>';
    },
    grafica: function () { return I._s('<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 4-6"/>'); },
    tabla:   function () { return I._s('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'); },
    imagen:  function () { return I._s('<path d="M21 15V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10"/><circle cx="9" cy="9" r="2"/><path d="m3 17 5-5 4 4"/><path d="M19 16v6m3-3h-6"/>'); },
    csv:     function () { return I._s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'); },
    sol:     function () { return I._s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'); },
    luna:    function () { return I._s('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'); },
    refresco:function () { return I._s('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'); },
    externo: function () { return I._s('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'); },
    arriba:  function () { return I._s('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'); },
    abajo:   function () { return I._s('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'); },
    igual:   function () { return I._s('<path d="M5 9h14M5 15h14"/>'); },
    imprimir:function () { return I._s('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>'); }
  };

  /* ------------------------------------------------------------ 2. Utilidad */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  Obs.esc = esc;

  /* "hace 3 días" a partir de una fecha ISO. */
  Obs.desde = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 90) return 'hace un momento';
    if (s < 5400) return 'hace ' + Math.round(s / 60) + ' min';
    if (s < 172800) return 'hace ' + Math.round(s / 3600) + ' h';
    return 'hace ' + Math.round(s / 86400) + ' días';
  };

  /* --------------------------------------------------------------- 3. Fichas */

  /**
   * Ficha de indicador.
   * @param {Object} k  {label, valor, unidad, dec, delta, deltaRef, invertir, serie, formato}
   * Contrato: etiqueta · valor · delta con periodo nombrado · sparkline opcional.
   */
  Obs.kpi = function (k) {
    var f = k.formato || Obs.fmt.num;
    var val = typeof f === 'function' ? f(k.valor, k.dec) : Obs.fmt.num(k.valor, k.dec);
    var d = '';
    if (k.delta != null && isFinite(k.delta)) {
      var sube = k.delta > 0.05, baja = k.delta < -0.05;
      /* El color lo decide si subir es bueno, no el signo. */
      var bueno = k.invertir ? baja : sube;
      var cls = (!sube && !baja) ? 'flat' : (bueno ? 'up' : 'down');
      var ico = sube ? I.arriba() : (baja ? I.abajo() : I.igual());
      d = '<div class="d ' + cls + '">' + ico +
        '<span>' + Obs.fmt.signo(k.delta, k.deltaDec == null ? 1 : k.deltaDec) + ' %</span>' +
        (k.deltaRef ? '<span class="ref">' + esc(k.deltaRef) + '</span>' : '') + '</div>';
    }
    var sp = k.serie ? Obs.spark(k.serie, k.sparkColor) : '';
    return '<div class="obs-kpi">' +
      '<div class="l">' + esc(k.label) + '</div>' +
      '<div class="v">' + val + (k.unidad ? '<small>' + esc(k.unidad) + '</small>' : '') + '</div>' +
      d + sp + '</div>';
  };

  /** Cifra protagonista: una sola por vista. */
  Obs.hero = function (h) {
    var f = h.formato || Obs.fmt.num;
    var bloques = (h.extra || []).map(function (e) {
      return '<div><div class="v" style="font-size:22px">' + (typeof (e.formato || f) === 'function' ? (e.formato || f)(e.valor, e.dec) : e.valor) +
        '</div><div class="l">' + esc(e.label) + '</div></div>';
    }).join('');
    return '<div class="obs-hero"><div><div class="v">' + (typeof f === 'function' ? f(h.valor, h.dec) : h.valor) +
      (h.unidad ? '<small style="font-size:18px;color:var(--ink-2);margin-left:4px">' + esc(h.unidad) + '</small>' : '') +
      '</div><div class="l">' + esc(h.label) + '</div></div>' + bloques + '</div>';
  };

  /* ------------------------------------------------------- 4. Tarjeta-gráfica */

  var seq = 0;

  /**
   * Tarjeta con gráfica, vista de tabla y exportación.
   * @param {Object} c {titulo, sub, chips, spec, fuente:{txt,url}, nota, ancho:'full', alto:'tall',
   *   control:{label, opciones:[{v,txt}], valor, spec(valor)}}
   */
  Obs.card = function (c) {
    var id = c.id || ('obs-c' + (++seq));
    /* Un selector en la cabecera para las tarjetas que muestran un corte de los
       datos (un año, una categoría) en lugar de una serie. La tarjeta sigue
       siendo la misma: cambia la spec, no la tarjeta. */
    var control = c.control
      ? '<label class="obs-card-ctrl"><span>' + esc(c.control.label || '') + '</span>' +
          '<select class="obs-select" data-ctrl="' + id + '">' +
            (c.control.opciones || []).map(function (o) {
              return '<option value="' + esc(o.v) + '"' +
                (String(o.v) === String(c.control.valor) ? ' selected' : '') + '>' +
                esc(o.txt == null ? o.v : o.txt) + '</option>';
            }).join('') +
          '</select></label>'
      : '';
    var chips = (c.chips || []).map(function (ch) {
      var cls = ch.tipo ? ' ' + ch.tipo : '';
      return '<span class="obs-chip' + cls + '">' + (ch.tipo === 'live' ? '<span class="dot"></span>' : '') + esc(ch.txt) + '</span>';
    }).join('');
    var fuente = c.fuente
      ? 'Fuente: <a href="' + esc(c.fuente.url) + '" target="_blank" rel="noopener">' + esc(c.fuente.txt) + ' ' + I.externo() + '</a>'
      : '';
    /* Un mapa no tiene vista de tabla ni exportación de gráfica: sus
       herramientas son los filtros, que dibuja el propio componente. */
    var herramientas = c.mapa ? '' :
      '<div class="obs-card-tools">' +
        '<button type="button" class="obs-icon-btn" data-act="tabla" aria-pressed="false" title="Ver los datos en tabla">' + I.tabla() + '</button>' +
        '<button type="button" class="obs-icon-btn" data-act="png" title="Descargar la gráfica en PNG">' + I.imagen() + '</button>' +
        '<button type="button" class="obs-icon-btn" data-act="csv" title="Descargar los datos en CSV">' + I.csv() + '</button>' +
      '</div>';
    var cuerpo = c.mapa
      ? '<div class="obs-map-host" id="' + id + '-mapa"></div>'
      : '<div class="obs-plot" id="' + id + '-plot"></div>' +
        '<div class="obs-table-wrap" id="' + id + '-tabla"></div>';

    return '<article class="obs-card' + (c.ancho === 'full' ? ' span-2' : '') + (c.alto === 'tall' ? ' tall' : '') + '" data-card="' + id + '">' +
      '<div class="obs-card-head">' +
        '<div class="t"><h3>' + esc(c.titulo) + '</h3>' +
          (c.sub ? '<div class="cs">' + esc(c.sub) + '</div>' : '') + '</div>' +
        control + herramientas +
      '</div>' +
      cuerpo +
      '<div class="obs-card-foot">' + chips + '<span>' + fuente + '</span>' +
        (c.nota ? '<span style="flex-basis:100%;font-style:italic">' + esc(c.nota) + '</span>' : '') +
      '</div></article>';
  };

  /* Tabla construida desde la misma spec que la gráfica: nunca se desincronizan.
     Es además el "relieve" que exige la paleta clara, así que no es opcional. */
  function tablaDeSpec(spec) {
    var T = Obs.tema();
    var xs = spec.x || [], ss = spec.series || [];
    var f = spec.tablaFormato || spec.yFormat;
    var fn = typeof f === 'function' ? f : function (v) {
      if (v == null || !isFinite(v)) return '—';
      return f === 'pct' ? Obs.fmt.pct(v) : (f === 'eur' ? Obs.fmt.eur(v) : Obs.fmt.num(v, f === 'dec1' ? 1 : 0));
    };
    var cab = '<th>' + esc(spec.xLabel || 'Periodo') + '</th>' + ss.map(function (s, i) {
      var col = s.color ? (T.estado[s.color] || s.color) : T.serie[i % T.serie.length];
      return '<th><span class="key" style="background:' + col + '"></span>' + esc(s.name) + '</th>';
    }).join('');
    var filas = xs.map(function (x, r) {
      return '<tr><td>' + esc(Obs.periodo(x, spec.xType || 'cat')) + '</td>' +
        ss.map(function (s) { return '<td>' + fn(s.data ? s.data[r] : null) + '</td>'; }).join('') + '</tr>';
    }).reverse().join('');   /* lo más reciente arriba: es lo que se consulta */
    return '<table class="obs-table"><thead><tr>' + cab + '</tr></thead><tbody>' + filas + '</tbody></table>';
  }

  function descargar(nombre, contenido, tipo) {
    var a = document.createElement('a');
    a.href = contenido.indexOf('data:') === 0 ? contenido
      : URL.createObjectURL(new Blob(['﻿' + contenido], { type: tipo || 'text/csv;charset=utf-8' }));
    a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function csvDeSpec(spec, titulo) {
    var xs = spec.x || [], ss = spec.series || [];
    var sep = ';';                                   /* Excel en español espera ; */
    var lin = [[spec.xLabel || 'Periodo'].concat(ss.map(function (s) { return s.name; })).join(sep)];
    xs.forEach(function (x, r) {
      lin.push([Obs.periodo(x, spec.xType || 'cat')].concat(ss.map(function (s) {
        var v = s.data ? s.data[r] : null;
        return v == null || !isFinite(v) ? '' : String(v).replace('.', ',');
      })).join(sep));
    });
    return lin.join('\r\n');
  }

  /* Un solo listener delegado para todas las tarjetas de todas las secciones. */
  function engancharTarjetas(raiz) {
    raiz.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.obs-card-tools button');
      if (!btn) return;
      var card = btn.closest('.obs-card');
      var plot = card.querySelector('.obs-plot');
      var spec = plot && plot.__obsSpec;
      var acto = btn.getAttribute('data-act');
      var nombre = (card.querySelector('h3') || {}).textContent || 'grafica';
      nombre = nombre.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 60);

      if (acto === 'tabla') {
        var wrap = card.querySelector('.obs-table-wrap');
        var abierta = card.classList.toggle('showing-table');
        btn.setAttribute('aria-pressed', abierta ? 'true' : 'false');
        btn.innerHTML = abierta ? I.grafica() : I.tabla();
        btn.title = abierta ? 'Volver a la gráfica' : 'Ver los datos en tabla';
        if (abierta && spec && !wrap.innerHTML) wrap.innerHTML = tablaDeSpec(spec);
        if (!abierta) Obs.resize();
        return;
      }
      if (!spec) return;
      if (acto === 'csv') { descargar(nombre + '.csv', csvDeSpec(spec, nombre)); return; }
      if (acto === 'png') {
        var inst = (typeof echarts !== 'undefined') && echarts.getInstanceByDom(plot);
        if (!inst) return;
        var T = Obs.tema();
        descargar(nombre + '.png', inst.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: T.surface }));
      }
    });
  }

  /* --------------------------------------------------------- 5. Composición */

  function pintarSeccion(sec) {
    var host = document.getElementById('sec-' + sec.id);
    if (!host || pintadas[sec.id]) return;
    pintadas[sec.id] = true;

    var res = sec.render ? sec.render(CFG.datos) : {};
    var html = '';
    if (sec.titulo || sec.desc) {
      html += '<div class="obs-section-head">' + (sec.titulo ? '<h2>' + esc(sec.titulo) + '</h2>' : '') +
        (sec.desc ? '<p>' + sec.desc + '</p>' : '') + '</div>';
    }
    if (res.nota) html += '<div class="obs-note' + (res.notaTipo === 'warn' ? ' warn' : '') + '">' + res.nota + '</div>';
    if (res.hero) html += Obs.hero(res.hero);
    if (res.kpis && res.kpis.length) html += '<div class="obs-kpis">' + res.kpis.map(Obs.kpi).join('') + '</div>';
    if (res.cards && res.cards.length) {
      html += '<div class="obs-grid' + (res.columnas ? ' cols-' + res.columnas : '') + '">' +
        res.cards.map(Obs.card).join('') + '</div>';
    }
    /* Bloque libre al final de la sección: listados, avisos largos, fichas…
       El kit no puede prever todo, pero tampoco hay que salirse de él para eso. */
    if (res.extra) html += res.extra;
    host.innerHTML = html;

    /* Las gráficas se dibujan cuando la sección ya tiene alto real. */
    (res.cards || []).forEach(function (c, i) {
      var art = host.querySelectorAll('.obs-card')[i];
      if (!art) return;
      if (c.mapa) {
        if (Obs.mapa) Obs.mapa(art.querySelector('.obs-map-host'), c.mapa);
        return;
      }
      if (!c.spec) return;
      var plot = art.querySelector('.obs-plot');
      Obs._observar(plot);
      Obs.chart(plot, c.spec);
      /* El selector redibuja la misma tarjeta con otra spec; la vista de tabla y
         la descarga leen la spec del nodo, así que se actualizan solas. */
      if (c.control && typeof c.control.spec === 'function') {
        var sel = art.querySelector('select[data-ctrl]');
        if (sel) sel.addEventListener('change', function () {
          art.classList.remove('showing-table');
          var wrap = art.querySelector('.obs-table-wrap');
          if (wrap) wrap.innerHTML = '';
          var btn = art.querySelector('.obs-card-tools button[data-act="tabla"]');
          if (btn) btn.setAttribute('aria-pressed', 'false');
          Obs.chart(plot, c.control.spec(sel.value));
        });
      }
    });
  }

  function activar(id) {
    CFG.secciones.forEach(function (s) {
      var sec = document.getElementById('sec-' + s.id);
      var btn = document.querySelector('.obs-nav button[data-sec="' + s.id + '"]');
      var on = s.id === id;
      if (sec) sec.hidden = !on;
      if (btn) btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var s = CFG.secciones.filter(function (x) { return x.id === id; })[0];
    if (s) pintarSeccion(s);
    Obs.resize();
    if (global.history && history.replaceState) history.replaceState(null, '', '#' + id);
  }
  Obs.ir = activar;

  /* ------------------------------------------------------------- 6. Tema */

  function temaGuardado() {
    try { return localStorage.getItem('obs-tema'); } catch (e) { return null; }
  }
  function aplicarTema(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { if (t) localStorage.setItem('obs-tema', t); else localStorage.removeItem('obs-tema'); } catch (e) {}
    var b = document.getElementById('obs-tema-btn');
    var oscuro = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    if (b) { b.innerHTML = oscuro ? I.sol() : I.luna(); b.title = oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'; }
    Obs.repintar();
    if (Obs.mapasRepintar) Obs.mapasRepintar();   /* las teselas también cambian de tema */
  }

  /* --------------------------------------------------------------- 7. init */

  /**
   * Monta el observatorio.
   * @param {Object} cfg
   *   titulo, subtitulo, datos, secciones:[{id,nombre,titulo,desc,render}],
   *   actualizado (ISO), fuentes:[{txt,url}], metodologia (HTML), pie (HTML)
   */
  Obs.init = function (cfg) {
    CFG = cfg;
    pintadas = {};
    var raiz = document.getElementById('obs-app') || document.body;

    var nav = cfg.secciones.map(function (s) {
      return '<button type="button" role="tab" data-sec="' + s.id + '" aria-selected="false">' + esc(s.nombre) + '</button>';
    }).join('');

    var secciones = cfg.secciones.map(function (s) {
      return '<section class="obs-section" id="sec-' + s.id + '" role="tabpanel" hidden></section>';
    }).join('');

    var fuentes = (cfg.fuentes || []).map(function (f) {
      return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.txt) + '</a>';
    }).join(' · ');

    raiz.innerHTML =
      '<header class="obs-header"><div class="obs-wrap obs-header-in">' +
        '<div class="obs-brand">' +
          '<div class="mark">' + (cfg.icono || I.grafica()) + '</div>' +
          '<div><h1 class="obs-title">' + esc(cfg.titulo) + '</h1>' +
          '<div class="obs-subtitle">' + esc(cfg.subtitulo || '') + '</div></div>' +
        '</div>' +
        '<div class="obs-header-actions">' +
          '<button type="button" class="obs-icon-btn" id="obs-imprimir" title="Imprimir o guardar en PDF">' + I.imprimir() + '</button>' +
          '<button type="button" class="obs-icon-btn" id="obs-tema-btn" title="Cambiar de tema">' + I.luna() + '</button>' +
        '</div>' +
      '</div></header>' +
      '<nav class="obs-nav"><div class="obs-wrap obs-nav-in" role="tablist">' + nav + '</div></nav>' +
      '<main class="obs-main"><div class="obs-wrap">' +
        '<div class="obs-toolbar">' +
          (cfg.controles || '') +
          '<div class="obs-status" id="obs-status"></div>' +
        '</div>' + secciones +
      '</div></main>' +
      '<footer class="obs-footer"><div class="obs-wrap"><div class="obs-footer-cols">' +
        '<div><h4>Fuentes</h4>' + fuentes + '</div>' +
        (cfg.metodologia ? '<div><h4>Metodología</h4>' + cfg.metodologia + '</div>' : '') +
        (cfg.pie ? '<div><h4>Aviso</h4>' + cfg.pie + '</div>' : '') +
      '</div></div></footer>';

    /* Eventos — siempre addEventListener, nunca onclick en el marcado. */
    raiz.querySelector('.obs-nav-in').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-sec]');
      if (b) activar(b.getAttribute('data-sec'));
    });
    engancharTarjetas(raiz);
    document.getElementById('obs-imprimir').addEventListener('click', function () { global.print(); });
    document.getElementById('obs-tema-btn').addEventListener('click', function () {
      var actual = document.documentElement.getAttribute('data-theme');
      var oscuroAhora = actual === 'dark' || (!actual && matchMedia('(prefers-color-scheme: dark)').matches);
      aplicarTema(oscuroAhora ? 'light' : 'dark');
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (!document.documentElement.getAttribute('data-theme')) Obs.repintar();
    });

    aplicarTema(temaGuardado());
    Obs.estado(cfg.actualizado ? 'Datos actualizados ' + Obs.desde(cfg.actualizado) : '');

    var inicial = (location.hash || '').replace('#', '');
    activar(cfg.secciones.some(function (s) { return s.id === inicial; }) ? inicial : cfg.secciones[0].id);
  };

  /** Texto de estado en la barra de controles. */
  Obs.estado = function (txt, tipo) {
    var e = document.getElementById('obs-status');
    if (!e) return;
    e.innerHTML = txt ? (tipo === 'live' ? '<span class="obs-chip live"><span class="dot"></span>En vivo</span>' : '') + esc(txt) : '';
  };

  /** Fuerza el repintado de una sección (tras cambiar un filtro). */
  Obs.refrescar = function (id) {
    pintadas[id] = false;
    var host = document.getElementById('sec-' + id);
    if (host) host.innerHTML = '';
    var s = CFG.secciones.filter(function (x) { return x.id === id; })[0];
    if (s) pintarSeccion(s);
  };

})(window);
