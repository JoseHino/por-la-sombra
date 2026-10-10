/* ============================================================================
   obs-charts.js — Envoltorio de ECharts para los Observatorios de Indicadores
   ----------------------------------------------------------------------------
   El código de cada observatorio NO llama nunca a la API de ECharts: llama a
   Obs.chart(el, spec). Así las especificaciones de marca (grosor de línea, tope
   de 24px en barras, extremo redondeado de 4px, rejilla hairline, leyenda a
   partir de 2 series, sin doble eje) se cumplen por construcción y no por
   disciplina.

   Depende de: echarts (CDN) y de las variables CSS de obs.css.
   ========================================================================== */
(function (global) {
  'use strict';

  var Obs = global.Obs = global.Obs || {};
  var registry = [];              // [{el, inst, spec}] para resize y cambio de tema

  /* ------------------------------------------------------------ 1. Formato */

  /* useGrouping 'always': en es-ES el separador se omite por defecto en los
     números de cuatro cifras (7133), y en una columna de indicadores eso lee
     como una inconsistencia frente a 82.242. Las estadísticas oficiales agrupan. */
  var NF = function (dec) {
    return new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: 'always'
    });
  };

  var fmt = Obs.fmt = {
    num: function (v, dec) {
      if (v == null || !isFinite(v)) return '—';
      return NF(dec == null ? 0 : dec).format(v);
    },
    dec1: function (v) { return fmt.num(v, 1); },
    pct: function (v, dec) { return v == null || !isFinite(v) ? '—' : fmt.num(v, dec == null ? 1 : dec) + ' %'; },
    eur: function (v, dec) { return v == null || !isFinite(v) ? '—' : fmt.num(v, dec == null ? 0 : dec) + ' €'; },
    /* Compacta para ejes y cifras grandes: 12,9 mil · 1,2 M */
    abbr: function (v) {
      if (v == null || !isFinite(v)) return '';
      var a = Math.abs(v);
      if (a >= 1e9) return fmt.num(v / 1e9, 1) + ' MM';
      if (a >= 1e6) return fmt.num(v / 1e6, 1) + ' M';
      if (a >= 1e4) return fmt.num(v / 1e3, 0) + ' mil';
      return fmt.num(v, 0);
    },
    signo: function (v, dec) {
      if (v == null || !isFinite(v)) return '—';
      return (v > 0 ? '+' : '') + fmt.num(v, dec == null ? 1 : dec);
    }
  };

  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var TRIM = { '03': '1T', '06': '2T', '09': '3T', '12': '4T', '1': '1T', '2': '2T', '3': '3T', '4': '4T' };

  /* Etiqueta de periodo. Acepta "2026-03", "2026T1" o "2026". */
  var lbl = Obs.periodo = function (t, tipo) {
    if (t == null) return '';
    var s = String(t);
    if (tipo === 'anual') return s.slice(0, 4);
    if (tipo === 'trim') {
      var mt = s.match(/^(\d{4})[-T]?(\d{1,2})$/);
      if (!mt) return s;
      return (TRIM[mt[2]] || TRIM[('0' + mt[2]).slice(-2)] || mt[2]) + ' ' + mt[1];
    }
    var m = s.match(/^(\d{4})-(\d{2})/);
    if (!m) return s;
    return MESES[+m[2] - 1] + ' ' + m[1].slice(2);
  };

  /* Resolve del formateador: nombre conocido, función propia o número crudo. */
  function resolveFmt(f) {
    if (typeof f === 'function') return f;
    if (f === 'pct') return function (v) { return fmt.pct(v); };
    if (f === 'pct0') return function (v) { return fmt.pct(v, 0); };
    if (f === 'eur') return function (v) { return fmt.eur(v); };
    if (f === 'dec1') return function (v) { return fmt.dec1(v); };
    if (f === 'dec2') return function (v) { return fmt.num(v, 2); };
    return function (v) { return fmt.num(v, 0); };
  }

  /* ------------------------------------------------------- 2. Tema (tokens) */

  /* Lee la paleta de las variables CSS: un solo sitio manda en claro y oscuro. */
  function tema() {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n, def) { return (cs.getPropertyValue(n) || '').trim() || def; };
    return {
      serie: [g('--s1', '#2a78d6'), g('--s2', '#eb6834'), g('--s3', '#1baf7a'), g('--s4', '#eda100'),
              g('--s5', '#e87ba4'), g('--s6', '#008300'), g('--s7', '#4a3aa7'), g('--s8', '#e34948')],
      estado: { ok: g('--ok', '#0ca30c'), warn: g('--warn', '#fab219'), serious: g('--serious', '#ec835a'), crit: g('--crit', '#d03b3b') },
      ink: g('--ink', '#0f1b2d'),
      ink2: g('--ink-2', '#44546b'),
      mut: g('--ink-mut', '#6b7c94'),
      grid: g('--grid', '#e7edf5'),
      axis: g('--axis', '#cfd9e6'),
      surface: g('--surface', '#ffffff'),
      line: g('--line', '#dfe6f0'),
      font: g('--font', 'Montserrat, sans-serif')
    };
  }
  Obs.tema = tema;

  /* Color de una serie: nombre de estado, hex explícito, o slot por posición.
     El color sigue a la entidad y jamás se recicla: a partir de 8 series el
     kit avisa en consola, porque lo correcto es agrupar en "Resto" o facetar. */
  function colorDe(s, i, T) {
    if (s.color) return T.estado[s.color] || s.color;
    if (i >= T.serie.length) {
      console.warn('[obs-charts] serie ' + (i + 1) + ' ("' + (s.name || '') + '"): ' +
        'la paleta tiene 8 slots. Agrupa en "Resto" o divide en varias gráficas en vez de reciclar colores.');
    }
    return T.serie[i % T.serie.length];
  }

  /* ------------------------------------------------------ 3. Piezas comunes */

  function ejeX(spec, T) {
    var tipo = spec.xType || 'cat';
    return {
      type: 'category',
      data: (spec.x || []).map(function (t) { return tipo === 'cat' ? t : lbl(t, tipo); }),
      boundaryGap: spec.type === 'bar' || spec.type === 'stack' || spec.type === 'barh',
      axisLine: { lineStyle: { color: T.axis } },
      axisTick: { show: false },
      axisLabel: {
        color: T.mut, fontSize: 11, fontFamily: T.font,
        /* `xTodas` obliga a rotular las doce categorías (los meses del año, los
           días de la semana): son pocas y con nombre corto, y saltarse una de
           cada dos deja el eje ilegible. Fuera de ese caso manda `hideOverlap`,
           que es lo correcto en una serie larga. */
        interval: spec.xTodas ? 0 : 'auto',
        hideOverlap: !spec.xTodas, margin: 10,
        rotate: spec.rotarX || 0
      },
      splitLine: { show: false }
    };
  }

  function ejeY(spec, T, fn) {
    /* Barras y áreas SIEMPRE desde cero: la longitud del rectángulo (o el área
       rellena) codifica la magnitud, y una base recortada la falsea. Las líneas
       sí pueden recortar el eje, que es donde importa la variación. */
    var exigeCero = spec.type === 'bar' || spec.type === 'stack' || spec.type === 'area';
    var cero = exigeCero || spec.desdeCero === true;
    return {
      type: 'value',
      name: spec.yLabel || '',
      nameTextStyle: { color: T.mut, fontSize: 11, fontFamily: T.font, align: 'left', padding: [0, 0, 6, -4] },
      nameGap: 12,
      min: spec.yMin != null ? spec.yMin : (cero ? 0 : undefined),
      max: spec.yMax,
      scale: spec.yMin == null && !cero,
      splitNumber: 5,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: T.mut, fontSize: 11, fontFamily: T.font,
        /* `abbr` redondea a entero, y en una serie de recorrido corto —la
           temperatura media anual va de 17 a 19— eso repite el mismo rótulo en
           varias marcas. En esas series el decimal solo se escribe donde hace
           falta: «18» y «18,5», nunca «50,0» en una escala que va de diez en diez. */
        formatter: function (v) {
          if (spec.yTick) return spec.yTick(v);
          if (spec.yFormat === 'pct') return fmt.pct(v, 0);
          if (spec.yFormat === 'dec1' || spec.yFormat === 'dec2') {
            return v % 1 === 0 ? fmt.num(v, 0) : fmt.num(v, spec.yFormat === 'dec2' ? 2 : 1);
          }
          return fmt.abbr(v);
        }
      },
      /* Rejilla: hairline sólida, un paso por encima de la superficie. Nunca discontinua. */
      splitLine: { lineStyle: { color: T.grid, width: 1, type: 'solid' } }
    };
  }

  function tooltip(spec, T, fn) {
    var esEje = spec.type === 'line' || spec.type === 'area' || spec.type === 'bar' || spec.type === 'stack';
    return {
      trigger: esEje ? 'axis' : 'item',
      confine: true,
      appendToBody: true,
      backgroundColor: T.surface,
      borderColor: T.line,
      borderWidth: 1,
      padding: [9, 12],
      textStyle: { color: T.ink, fontSize: 12.5, fontFamily: T.font },
      extraCssText: 'box-shadow:0 6px 22px rgba(15,27,45,.14);border-radius:8px;',
      /* Cruceta en las series temporales, tal y como pide el kit. */
      axisPointer: esEje ? {
        type: 'line',
        lineStyle: { color: T.axis, width: 1 },
        label: { show: false }
      } : undefined,
      formatter: function (p) {
        var arr = Array.isArray(p) ? p : [p];
        if (!arr.length) return '';
        var cab = '<div style="font-weight:600;margin-bottom:5px">' + (arr[0].axisValueLabel || arr[0].name || '') + '</div>';
        var filas = arr.map(function (it) {
          var v = it.value != null && typeof it.value === 'object' ? it.value[1] : it.value;
          return '<div style="display:flex;gap:10px;align-items:center;margin:2px 0">' +
            '<span style="width:9px;height:9px;border-radius:2px;background:' + it.color + ';flex:none"></span>' +
            '<span style="color:' + T.ink2 + ';flex:1 1 auto">' + it.seriesName + '</span>' +
            '<b style="font-variant-numeric:tabular-nums">' + fn(v) + (spec.unidad ? ' ' + spec.unidad : '') + '</b>' +
            '</div>';
        }).join('');
        return cab + filas;
      }
    };
  }

  /* Leyenda: presente siempre con 2+ series, ausente con 1 (el título ya la nombra). */
  function leyenda(spec, T, n, nombres) {
    if (n < 2 || spec.legend === false) return { show: false };
    return {
      /* data explícito: si no, la serie fantasma que dibuja la línea de
         referencia aparecería en la leyenda como si fuera un dato más. */
      data: nombres,
      show: true, type: 'scroll', bottom: 0, left: 'center',
      itemWidth: 11, itemHeight: 11, itemGap: 14, icon: 'roundRect',
      textStyle: { color: T.ink2, fontSize: 11.5, fontFamily: T.font },
      pageTextStyle: { color: T.mut, fontSize: 11 },
      pageIconColor: T.mut, pageIconInactiveColor: T.grid, pageIconSize: 10
    };
  }

  /* -------------------------------------------------- 4. Constructor de spec */

  function construir(spec) {
    var T = tema();
    var fn = resolveFmt(spec.yFormat);
    var ss = spec.series || [];
    var n = ss.length;
    var hayLeyenda = n >= 2 && spec.legend !== false;

    if (spec.yAxis2 || spec.y2) {
      console.warn('[obs-charts] doble eje Y descartado: usa dos gráficas o indexa a base 100. Ver docs/03-diseno.md.');
    }

    /* --- circular (donut). Solo para partes de un total, <= 6 categorías. --- */
    if (spec.type === 'donut' || spec.type === 'pie') {
      var datos = (spec.x || []).map(function (nom, i) {
        return { name: nom, value: (ss[0] && ss[0].data[i]), itemStyle: { color: T.serie[i % T.serie.length] } };
      });
      return {
        color: T.serie,
        tooltip: tooltip(spec, T, fn),
        legend: {
          show: true, orient: 'vertical', right: 8, top: 'middle',
          itemWidth: 11, itemHeight: 11, itemGap: 10, icon: 'roundRect',
          textStyle: { color: T.ink2, fontSize: 11.5, fontFamily: T.font }
        },
        series: [{
          type: 'pie', radius: spec.type === 'donut' ? ['52%', '76%'] : ['0%', '72%'],
          center: ['34%', '50%'], data: datos, avoidLabelOverlap: true,
          /* 2px de superficie separando los sectores: el hueco separa, no un borde. */
          itemStyle: { borderColor: T.surface, borderWidth: 2 },
          label: { show: false },
          emphasis: { scale: true, scaleSize: 4 }
        }]
      };
    }

    /* ------------------------------- barras horizontales (ranking) --------- */
    if (spec.type === 'barh') {
      var cats = spec.x || [];
      return {
        /* left generoso: con containLabel, ECharts recorta la primera letra de las
           etiquetas largas del eje de categorías si el margen es demasiado justo. */
        grid: { left: 14, right: 52, top: 12, bottom: 6, containLabel: true },
        tooltip: tooltip(spec, T, fn),
        legend: leyenda(spec, T, n, ss.map(function (x) { return x.name; })),
        xAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false },
                 axisLabel: { color: T.mut, fontSize: 11, fontFamily: T.font, formatter: function (v) { return fmt.abbr(v); } },
                 splitLine: { lineStyle: { color: T.grid, width: 1, type: 'solid' } } },
        yAxis: { type: 'category', data: cats, inverse: true,
                 axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false },
                 axisLabel: { color: T.ink2, fontSize: 11.5, fontFamily: T.font } },
        series: ss.map(function (s, i) {
          return {
            name: s.name, type: 'bar', data: s.data,
            barMaxWidth: 24,                                  /* tope, nunca rellena el hueco */
            itemStyle: { color: colorDe(s, i, T), borderRadius: [0, 4, 4, 0] },
            /* Etiqueta directa en la punta: el relieve que exige la paleta clara. */
            label: n === 1 ? { show: true, position: 'right', color: T.ink2, fontSize: 11,
                               fontFamily: T.font, formatter: function (p) { return fn(p.value); } }
                           : { show: false }
          };
        })
      };
    }

    /* -------------------------- líneas, áreas, barras y apiladas ----------- */
    var apilar = spec.type === 'stack';
    var esBarra = spec.type === 'bar' || apilar;
    var series = ss.map(function (s, i) {
      var col = colorDe(s, i, T);
      var ultimo = spec.labelLast !== false && n <= 4 && !esBarra;
      var base = {
        name: s.name,
        data: s.data,
        z: 3 + i,
        emphasis: { focus: 'series' }
      };
      if (esBarra) {
        return Object.assign(base, {
          type: 'bar',
          stack: apilar ? (s.stack || 'total') : undefined,
          barMaxWidth: 24,
          barGap: '12%',
          itemStyle: {
            color: col,
            /* extremo de dato redondeado 4px, escuadra en la línea base */
            borderRadius: apilar ? 0 : [4, 4, 0, 0],
            /* 2px del color de superficie separando segmentos apilados */
            borderColor: apilar ? T.surface : 'transparent',
            borderWidth: apilar ? 2 : 0
          }
        });
      }
      return Object.assign(base, {
        type: 'line',
        smooth: false,
        symbol: 'circle',
        symbolSize: 8,                                    /* >= 8px para que se pueda apuntar */
        showSymbol: (spec.x || []).length <= 18,
        lineStyle: { width: 2, color: col, type: s.dashed ? 'dashed' : 'solid', cap: 'round', join: 'round' },
        /* anillo de 2px en color superficie: el punto se lee aunque se cruce */
        itemStyle: { color: col, borderColor: T.surface, borderWidth: 2 },
        areaStyle: (spec.type === 'area') ? { color: col, opacity: .10 } : undefined,
        /* etiqueta directa solo en el extremo, nunca en cada punto */
        endLabel: ultimo ? {
          show: true, color: T.ink2, fontSize: 11, fontFamily: T.font, fontWeight: 600,
          distance: 6, formatter: function (p) { return fn(p.value); }
        } : { show: false }
      });
    });

    var conZoom = spec.zoom === true || (spec.zoom !== false && (spec.x || []).length > 36);

    return {
      grid: {
        left: 4,
        right: (spec.labelLast !== false && !esBarra && n <= 4) ? 52 : 12,
        top: spec.yLabel ? 26 : 14,
        bottom: (hayLeyenda ? 26 : 2) + (conZoom ? 30 : 0),
        containLabel: true
      },
      tooltip: tooltip(spec, T, fn),
      legend: leyenda(spec, T, n, ss.map(function (x) { return x.name; })),
      xAxis: ejeX(spec, T),
      yAxis: ejeY(spec, T, fn),
      dataZoom: conZoom ? [
        { type: 'inside', start: spec.zoomDesde == null ? 55 : spec.zoomDesde, end: 100 },
        { type: 'slider', height: 18, bottom: hayLeyenda ? 24 : 2, start: spec.zoomDesde == null ? 55 : spec.zoomDesde, end: 100,
          borderColor: 'transparent', backgroundColor: T.grid,
          fillerColor: 'rgba(42,120,214,.14)', handleStyle: { color: T.surface, borderColor: T.axis },
          moveHandleStyle: { color: T.axis }, textStyle: { color: T.mut, fontSize: 10, fontFamily: T.font },
          dataBackground: { lineStyle: { color: T.axis }, areaStyle: { color: T.grid } },
          selectedDataBackground: { lineStyle: { color: T.serie[0] }, areaStyle: { color: T.serie[0], opacity: .12 } } }
      ] : undefined,
      /* Línea de referencia opcional (media, objetivo, umbral legal). */
      series: spec.ref == null ? series : series.concat([{
        type: 'line', name: spec.refLabel || 'Referencia', data: [], silent: true,
        markLine: {
          symbol: 'none', animation: false,
          data: [{ yAxis: spec.ref }],
          lineStyle: { color: T.mut, width: 1, type: 'dashed' },
          label: { show: true, position: 'insideEndTop', color: T.mut, fontSize: 10.5,
                   fontFamily: T.font, formatter: spec.refLabel || fn(spec.ref) }
        }
      }])
    };
  }

  /* --------------------------------------------------------- 5. API pública */

  /**
   * Dibuja una gráfica.
   * @param {HTMLElement|string} el  contenedor (.obs-plot) o su selector
   * @param {Object} spec            ver docs/03-diseno.md
   * @returns {Object|null} instancia de ECharts
   */
  Obs.chart = function (el, spec) {
    var nodo = typeof el === 'string' ? document.querySelector(el) : el;
    if (!nodo) { console.warn('[obs-charts] contenedor no encontrado:', el); return null; }
    if (typeof echarts === 'undefined') { Obs.mensaje(nodo, 'error', 'No se pudo cargar la librería de gráficas.'); return null; }

    var vacio = !spec.series || !spec.series.length ||
      spec.series.every(function (s) { return !s.data || !s.data.some(function (v) { return v != null && isFinite(v); }); });
    if (vacio) { Obs.mensaje(nodo, 'vacio', spec.vacioTxt || 'Sin datos publicados para este indicador.'); return null; }

    nodo.classList.remove('is-loading');
    /* Volver a dibujar sobre el mismo contenedor —una tarjeta con selector, un
       mensaje de vacío que se sustituye por datos— exige soltar la instancia
       anterior ANTES de vaciar el nodo: si se vacía sin más, ECharts sigue
       teniendo por buena una instancia cuyo lienzo ya no está en el documento y
       la tarjeta se queda en blanco sin dar error. */
    var previa = echarts.getInstanceByDom(nodo);
    if (previa) previa.dispose();
    nodo.innerHTML = '';

    /* Canvas y no SVG: es lo que permite exportar el PNG que acaba en los informes. */
    var inst = echarts.init(nodo, null, { renderer: 'canvas', devicePixelRatio: 2 });
    inst.setOption(construir(spec), true);

    /* La spec viaja con el nodo: la vista de tabla y la exportación la releen. */
    nodo.__obsSpec = spec;
    registry = registry.filter(function (r) { return r.el !== nodo; });
    registry.push({ el: nodo, inst: inst, spec: spec });
    return inst;
  };

  /** Vuelve a dibujar todo con los tokens actuales (tras cambiar de tema). */
  Obs.repintar = function () {
    registry.forEach(function (r) {
      if (document.body.contains(r.el)) r.inst.setOption(construir(r.spec), true);
    });
  };

  /** Reajusta al tamaño del contenedor. Se llama solo (ver más abajo). */
  Obs.resize = function () {
    registry.forEach(function (r) { if (r.el.offsetParent !== null) r.inst.resize(); });
  };

  /** Estado de carga / vacío / error dentro de un contenedor de gráfica. */
  Obs.mensaje = function (nodo, tipo, texto) {
    var n = typeof nodo === 'string' ? document.querySelector(nodo) : nodo;
    if (!n) return;
    var ico = tipo === 'error'
      ? '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'
      : '<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 4-6"/>';
    n.classList.remove('is-loading');
    n.innerHTML = '<div class="obs-msg ' + (tipo === 'error' ? 'error' : '') + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ico + '</svg>' +
      '<span>' + texto + '</span></div>';
  };

  /** Marca un contenedor como "cargando" (esqueleto). */
  Obs.cargando = function (nodo) {
    var n = typeof nodo === 'string' ? document.querySelector(nodo) : nodo;
    if (!n) return;
    n.classList.add('is-loading');
    n.innerHTML = '<div class="obs-skeleton" style="width:100%;height:100%"></div>';
  };

  /** Sparkline de una ficha KPI: SVG puro, sin ECharts (van decenas por vista). */
  Obs.spark = function (datos, color) {
    var v = (datos || []).filter(function (x) { return x != null && isFinite(x); });
    if (v.length < 2) return '';
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v), rango = (max - min) || 1;
    var W = 96, H = 34, P = 3;
    var pts = v.map(function (y, i) {
      return [(i / (v.length - 1)) * (W - P * 2) + P, H - P - ((y - min) / rango) * (H - P * 2)];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var fin = pts[pts.length - 1];
    var c = color || 'var(--brand)';
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + fin[0].toFixed(1) + '" cy="' + fin[1].toFixed(1) + '" r="2.6" fill="' + c + '"/></svg>';
  };

  /* Reajuste: ResizeObserver por tarjeta, con respaldo al evento window. */
  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function () { Obs.resize(); });
    Obs._observar = function (n) { try { ro.observe(n); } catch (e) {} };
  } else {
    Obs._observar = function () {};
  }
  var t = null;
  global.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(Obs.resize, 120); });

})(window);
