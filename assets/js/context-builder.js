/* Bismillah Product Intelligence Platform — Context Builder (Fase 2, Paso 2)
 *
 * Módulo independiente y sin estado: a partir de un producto, construye el
 * contexto estructurado (JSON serializable) que un futuro AI Sales Copilot
 * podrá recibir como entrada. No renderiza nada, no escucha eventos, no
 * llama a ninguna API externa ni de IA, y no depende del DOM ni de app.js —
 * solo lee el dataset `DATA` (assets/js/data.js), el mismo modelo de datos
 * descrito en docs/PROJECT_BRIEF.md.
 *
 * Bloque `comercial`: los campos precio/stock/margen/estado quedan
 * declarados y en null a propósito — es la forma del contrato ya preparada
 * para cuando la Fase 1 (Integración de Datos) entregue esa información
 * real. Este módulo no fabrica, estima ni simula esos valores.
 */
'use strict';

const ContextBuilder = (function () {
  const SCHEMA_VERSION = '1.0.0';
  const CONF_LABEL = ['Alta', 'Media', 'Baja'];
  const CONF_KEY = ['alta', 'media', 'baja'];

  function deriveFamilyCode(subcatLabel) {
    if (!subcatLabel) return null;
    const m = subcatLabel.match(/^([BF]\d+)/);
    return m ? m[1] : null;
  }

  // Recalculado a partir de DATA.rels en cada build() en vez de reutilizar el
  // `adj` de app.js: mantiene el módulo desacoplado (no requiere que app.js se
  // haya cargado ni en qué orden) a costa de un recorrido de ~15k aristas por
  // llamada, insignificante frente al tamaño del catálogo actual.
  function buildAdjacency(data) {
    const adj = Array.from({ length: data.products.length }, () => []);
    for (const [a, b, t, c, j] of data.rels) {
      adj[a].push({ o: b, t, c, j });
      adj[b].push({ o: a, t, c, j });
    }
    return adj;
  }

  function resolveIndex(data, productRef) {
    if (typeof productRef === 'number') {
      return Number.isInteger(productRef) && productRef >= 0 && productRef < data.products.length
        ? productRef
        : -1;
    }
    const sku = String(productRef);
    return data.products.findIndex(p => String(p[0]) === sku);
  }

  function summarizeByType(entries, data) {
    const acc = data.types.map(() => ({ alta: 0, media: 0, baja: 0 }));
    for (const e of entries) acc[e.t][CONF_KEY[e.c]]++;
    return data.types
      .map((tipo, t) => {
        const c = acc[t];
        const cantidad = c.alta + c.media + c.baja;
        return cantidad ? { tipo, cantidad, confianza: { ...c } } : null;
      })
      .filter(Boolean);
  }

  function buildDetail(entries, data, maxPerType) {
    const perTypeCount = new Map();
    const detalle = [];
    // Alta antes que Media antes que Baja — mismo criterio de prioridad que
    // ya usa Producto 360 al elegir qué vecinos mostrar primero.
    const ordered = [...entries].sort((a, b) => a.c - b.c);
    for (const e of ordered) {
      const used = perTypeCount.get(e.t) || 0;
      if (used >= maxPerType) continue;
      perTypeCount.set(e.t, used + 1);
      const other = data.products[e.o];
      detalle.push({
        sku: String(other[0]),
        nombre: other[1],
        tipo: data.types[e.t],
        confianza: CONF_LABEL[e.c],
        justificacion: data.justs[e.j],
      });
    }
    return detalle;
  }

  /**
   * Construye el contexto de un producto.
   * @param {number|string} productRef Índice del producto (como P[i] en app.js) o su SKU.
   * @param {{data?:object, maxPerType?:number}} [options]
   *   data: dataset alternativo (por defecto usa el global DATA) — pensado para tests.
   *   maxPerType: tope de relaciones detalladas por tipo (default 8); no afecta a `porTipo`,
   *   que siempre refleja el total real.
   * @returns {object|null} Contexto serializable, o null si el producto no existe.
   */
  function build(productRef, options = {}) {
    const data = options.data || (typeof DATA !== 'undefined' ? DATA : null);
    if (!data) {
      throw new Error(
        'ContextBuilder.build: no hay dataset disponible. Carga assets/js/data.js antes ' +
        'de invocar el builder, o pásalo explícitamente en options.data.'
      );
    }

    const idx = resolveIndex(data, productRef);
    if (idx < 0) return null;

    const [sku, nombre, subcatIdx, , tagsCsv, audIdx] = data.products[idx];
    const subcategoria = subcatIdx >= 0 ? data.subcats[subcatIdx] : null;
    const familiaCodigo = deriveFamilyCode(subcategoria);
    const universoCodigo = familiaCodigo ? familiaCodigo[0] : null;
    const tags = tagsCsv ? tagsCsv.split(',').map(s => s.trim()).filter(Boolean) : [];
    const audiencias = (audIdx || []).map(a => data.auds[a]);

    const entries = buildAdjacency(data)[idx];
    const maxPerType = Number.isInteger(options.maxPerType) && options.maxPerType > 0
      ? options.maxPerType
      : 8;

    return {
      meta: {
        schemaVersion: SCHEMA_VERSION,
        generadoEn: new Date().toISOString(),
        productoIndice: idx,
      },
      producto: {
        sku: String(sku),
        nombre,
        universoCodigo,
        universo: universoCodigo === 'B' ? 'Bienestar' : universoCodigo === 'F' ? 'Farma' : null,
        familiaCodigo,
        subcategoria,
        tags,
        audiencias,
      },
      relaciones: {
        total: entries.length,
        porTipo: summarizeByType(entries, data),
        detalle: buildDetail(entries, data, maxPerType),
        detalleLimitadoPorTipo: maxPerType,
      },
      // Preparado para la Fase 1 (Integración de Datos). Mientras esa fase no
      // entregue estos campos, se exponen en null — nunca con valores de ejemplo.
      comercial: {
        disponible: false,
        precio: null,
        stock: null,
        margen: null,
        estado: null,
        pendienteDe: 'Fase 1 — Integración de Datos',
      },
    };
  }

  return { build, SCHEMA_VERSION };
})();
