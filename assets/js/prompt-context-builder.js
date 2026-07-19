/* Bismillah Product Intelligence Platform — Prompt Context Builder (Fase 4, Paso 2)
 *
 * Transforma el `Context` que ya produce ContextBuilder.build() en un
 * `PromptContext` estructurado, determinístico y desacoplado, listo para que
 * un futuro AIResponseProvider razone sobre él. Este módulo NO genera texto
 * en lenguaje natural, NO decide qué proveedor usar, NO llama a ningún
 * modelo ni API, y NO accede a ninguna fuente de datos por su cuenta — toda
 * la información sale, exclusivamente, del objeto `context` que recibe.
 *
 * Separación de responsabilidades (por diseño, no por casualidad):
 *   - ProductKnowledge: qué es el producto (conocimiento de catálogo).
 *   - CommercialContext: qué vale y qué disponibilidad tiene (dato comercial).
 *   - Alternatives / CrossSell: candidatos reales del grafo, agrupados y
 *     filtrados por la política de calidad ya vigente en el proyecto
 *     (R-PIG-04 — excluir confianza Baja por defecto), SIN puntuarlos ni
 *     elegir un ganador. Puntuar/rankear es una decisión de respuesta (lo
 *     que ya hace LocalResponseProvider para "Mejor alternativa"/"Venta
 *     cruzada"), no de organización de contexto — este módulo entrega los
 *     hechos elegibles; quién razone sobre ellos decide el orden.
 *   - UserIntent: nunca se infiere. Es exactamente lo que el llamador pasa
 *     en `options.intent` (o `null` si no se pasa nada) — Context Builder
 *     no sabe nada sobre la intención de quien pregunta, así que este
 *     módulo tampoco puede inventarla.
 *
 * Por qué no importa nada de providers/local-response-provider.js: sus
 * funciones (extractQuoted, collectBenefits, etc.) viven en un closure
 * privado y ese archivo está fuera de alcance de este paso ("No modificar
 * LocalResponseProvider"). Se reaplica aquí la misma técnica de extracción
 * ya validada (comillas simples en la justificación), verificada contra el
 * 100% de las justificaciones MISMO_BENEFICIO y MISMO_INGREDIENTE del
 * catálogo — ver scripts/verify-prompt-context-builder.js. Es la misma
 * decisión ya tomada 3 veces antes en este proyecto (familiaCodigo,
 * TYPE_LABELS, pesos de venta cruzada): mantener cada módulo del Copilot
 * independiente de los demás, incluso a costa de una pequeña reaplicación.
 */
'use strict';

const PromptContextBuilder = (function () {
  const SCHEMA_VERSION = '1.0.0';

  const ALTERNATIVE_TYPES = ['SUSTITUYE'];
  const CROSS_SELL_TYPES = ['COMPLEMENTA', 'MISMO_BENEFICIO', 'MISMA_AUDIENCIA', 'MISMO_INGREDIENTE'];

  function extractQuoted(text) {
    const m = /'([^']+)'/.exec(text || '');
    return m ? m[1] : null;
  }

  // beneficios/ingredientes: nombres de atributo (no SKUs), extraídos del
  // texto entrecomillado de las justificaciones del tipo correspondiente.
  // Deduplicado con Set — el mismo beneficio/ingrediente puede repetirse en
  // varias relaciones distintas del mismo producto.
  function collectAttribute(detalle, tipo) {
    const set = new Set();
    for (const d of detalle) {
      if (d.tipo !== tipo) continue;
      const v = extractQuoted(d.justificacion);
      if (v) set.add(v);
    }
    return [...set];
  }

  // Alternatives/CrossSell: candidatos reales (otros SKUs), agrupados por
  // sku para que un mismo candidato conectado por varias relaciones
  // elegibles aparezca UNA sola vez con todas sus relaciones adjuntas — sin
  // eso, el mismo sku aparecería duplicado en la lista. Confianza Baja
  // excluida por defecto: política R-PIG-04, ya vigente en Panorama,
  // Motores, "Mejor alternativa" y "Venta cruzada" — se reaplica aquí, no
  // se inventa. Ningún score ni ranking: eso es una decisión de respuesta,
  // fuera de alcance de este módulo.
  function groupCandidatesByType(detalle, tipos) {
    const bySku = new Map();
    for (const d of detalle) {
      if (!tipos.includes(d.tipo) || d.confianza === 'Baja') continue;
      if (!bySku.has(d.sku)) bySku.set(d.sku, { sku: d.sku, nombre: d.nombre, relaciones: [] });
      bySku.get(d.sku).relaciones.push({
        tipo: d.tipo,
        confianza: d.confianza,
        justificacion: d.justificacion,
      });
    }
    return [...bySku.values()];
  }

  function buildProductKnowledge(context) {
    const { producto, relaciones } = context;
    return {
      nombre: producto.nombre,
      familia: producto.subcategoria,
      beneficios: collectAttribute(relaciones.detalle, 'MISMO_BENEFICIO'),
      ingredientes: collectAttribute(relaciones.detalle, 'MISMO_INGREDIENTE'),
      relaciones: {
        total: relaciones.total,
        porTipo: relaciones.porTipo,
      },
      metadata: {
        sku: producto.sku,
        familiaCodigo: producto.familiaCodigo,
        universoCodigo: producto.universoCodigo,
        universo: producto.universo,
        tags: producto.tags,
        audiencias: producto.audiencias,
        schemaVersion: context.meta.schemaVersion,
        generadoEn: context.meta.generadoEn,
        productoIndice: context.meta.productoIndice,
      },
    };
  }

  function buildCommercialContext(context) {
    const { comercial } = context;
    return {
      precio: comercial.precio,
      precioLista: comercial.precioLista,
      stock: comercial.stock,
      estado: comercial.estado,
      disponibilidad: comercial.disponible,
    };
  }

  function buildAlternatives(context) {
    return groupCandidatesByType(context.relaciones.detalle, ALTERNATIVE_TYPES);
  }

  function buildCrossSell(context) {
    return groupCandidatesByType(context.relaciones.detalle, CROSS_SELL_TYPES);
  }

  /**
   * Construye el PromptContext de un producto a partir de su Context ya
   * construido por ContextBuilder.build().
   * @param {object} context Objeto devuelto por ContextBuilder.build() — NO se llama a ContextBuilder aquí.
   * @param {{intent?: *}} [options]
   *   intent: lo que el llamador considere la intención del usuario (string, objeto, o lo que sea).
   *   Se relaya tal cual en `userIntent`; si se omite, `userIntent` queda en `null`. Este módulo
   *   nunca infiere ni fabrica una intención.
   * @returns {object} PromptContext serializable.
   */
  function build(context, options = {}) {
    if (!context || !context.producto || !context.relaciones || !context.comercial || !context.meta) {
      throw new Error(
        'PromptContextBuilder.build: contexto inválido o incompleto. Se espera el objeto que devuelve ContextBuilder.build().'
      );
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      productKnowledge: buildProductKnowledge(context),
      commercialContext: buildCommercialContext(context),
      alternatives: buildAlternatives(context),
      crossSell: buildCrossSell(context),
      userIntent: options.intent === undefined ? null : options.intent,
    };
  }

  return { build, SCHEMA_VERSION };
})();
