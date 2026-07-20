/* Bismillah Product Intelligence Platform — Gemini Prompt Builder (Fase 4, Paso 5)
 *
 * Construcción FINAL del prompt de texto que gemini-proxy-server.js envía a
 * Gemini — extraído de ese archivo a un módulo propio, testeable de forma
 * independiente, siguiendo la misma disciplina de una responsabilidad por
 * archivo que ya rige el resto del proyecto (Context Builder vs. Response
 * Provider, PromptContextBuilder vs. LocalResponseProvider, etc.).
 *
 * Es la única pieza de todo el sistema que traduce un PromptContext (datos
 * estructurados, Fase 4 Paso 2) a lenguaje natural para un modelo —
 * PromptContextBuilder tiene explícitamente prohibido hacer esto; aquí es
 * exactamente lo que se necesita para invocar un LLM real.
 *
 * Fase 4, Paso 5 — qué cambió respecto al prompt del Paso 4: se agregan
 * INSTRUCCIONES DE GROUNDING específicas por habilidad
 * (SKILL_GROUNDING_HINTS), no solo la regla genérica "no inventes datos".
 * La razón concreta: "Mejor alternativa" y "Venta cruzada" ya llegan al
 * modelo con sus candidatos PRE-FILTRADOS por PromptContextBuilder según la
 * política R-PIG-04 (excluir confianza Baja) — sin una instrucción
 * explícita, nada le impide al modelo "mejorar" la respuesta sugiriendo un
 * producto que no está en esa lista ya filtrada, deshaciendo esa política
 * de negocio sin que nadie lo note. La instrucción por sí sola es defensa
 * en profundidad, no la única barrera — gemini-proxy-server.js valida
 * server-side, después de recibir la respuesta, que cualquier SKU citado
 * realmente pertenezca a los candidatos enviados (ver
 * validateGroundedSkuUsage en ese archivo). El prompt reduce cuántas
 * respuestas necesitan ese rechazo; la validación server-side es la que
 * realmente lo garantiza.
 */
'use strict';

// Mismo contrato ya documentado en response-provider.js — se repite aquí en
// forma de instrucción para el modelo, no como una nueva fuente de verdad:
// si ese contrato cambia, este mapa debe actualizarse junto con él.
const COMPARE_PRODUCT_SUMMARY_SCHEMA = '{ "sku": "...", "nombre": "...", "universo": "...", "categoria": "...", "beneficios": ["..."], "etiquetas": ["..."], "relaciones": { "total": 0, "porTipo": [ { "tipo": "...", "cantidad": 0 } ] } }';

const SKILL_SCHEMAS = {
  'explain-product': '{ "skill": "explain-product", "text": "<explicación en español, basada EXCLUSIVAMENTE en los datos de productKnowledge/commercialContext>" }',
  'compare-products': `{ "skill": "compare-products", "productos": { "a": ${COMPARE_PRODUCT_SUMMARY_SCHEMA}, "b": ${COMPARE_PRODUCT_SUMMARY_SCHEMA} }, "similitudes": ["..."], "diferencias": ["..."] }`,
  'best-alternative': '{ "skill": "best-alternative", "encontrado": true, "alternativa": { "sku": "...", "nombre": "..." }, "afinidad": "Alta", "justificacion": "...", "mensaje": null }',
  'cross-sell': 'Usa EXACTAMENTE una de estas dos formas. Con recomendaciones: { "skill": "cross-sell", "recomendaciones": [ { "sku": "...", "nombre": "...", "razon": "..." } ], "mensaje": null }. Sin candidatos elegibles: { "skill": "cross-sell", "recomendaciones": [], "mensaje": "<explicación honesta en español>" }',
  'price-availability': '{ "skill": "price-availability", "disponible": true, "precio": 0, "precioLista": 0, "priceDifference": 0, "stock": 0, "estado": "...", "mensaje": null }',
};

// Instrucción de grounding específica por habilidad — más allá de la regla
// genérica "no inventes datos". Cada una nombra explícitamente el bloque
// del PromptContext (Fase 4, Paso 2) del que esa habilidad debe depender,
// y qué NO debe hacer con él.
const SKILL_GROUNDING_HINTS = {
  'explain-product': 'Usa productKnowledge y commercialContext. Si commercialContext.disponibilidad es false, dilo honestamente en el texto sin inventar un precio ni un stock.',
  'compare-products': 'El PromptContext trae DOS productos independientes en las claves "a" y "b" (cada una con su propio productKnowledge/commercialContext/alternatives/crossSell). Compara únicamente lo que ambos exponen — no mezcles datos de "a" con los de "b". En productos.a/productos.b copia todos los campos del resumen desde cada productKnowledge: sku=metadata.sku, nombre=nombre, universo=metadata.universo, categoria=familia, beneficios=beneficios, etiquetas=metadata.tags y relaciones=relaciones; no omitas arrays vacíos ni relaciones.porTipo.',
  'best-alternative': 'La alternativa que devuelvas debe ser EXACTAMENTE uno de los candidatos ya listados en "alternatives" (por su sku) — nunca sugieras un producto que no esté en esa lista, aunque te parezca más adecuado. Si "alternatives" está vacío, responde encontrado:false con un mensaje honesto explicando que no hay un sustituto elegible.',
  'cross-sell': 'Las recomendaciones que devuelvas deben ser EXCLUSIVAMENTE candidatos ya listados en "crossSell". Para cada recomendación copia exactamente "sku" y "nombre" del candidato y agrega "razon" como string no vacío; no traduzcas, acentúes ni renombres esas tres claves. Incluye siempre "mensaje": debe ser null cuando recomendaciones tenga elementos. Si no hay candidatos elegibles, responde recomendaciones:[] y "mensaje" como string no vacío explicándolo honestamente. Nunca agregues un producto que no esté en "crossSell".',
  'price-availability': 'Usa exclusivamente commercialContext. Si "disponibilidad" es false, "disponible" en tu respuesta también debe ser false y los campos numéricos deben ser null — nunca reportes disponibilidad o un precio que el PromptContext no confirma.',
};

/**
 * Arma el prompt de texto final que se envía a Gemini para una habilidad y
 * un PromptContext concretos.
 * @param {string} skill Uno de los 5 identificadores del contrato (ver SKILL_SCHEMAS).
 * @param {object} promptContext El objeto que envía RemoteResponseProvider — para
 *   'compare-products' es `{a: PromptContext, b: PromptContext}`; para el resto,
 *   un PromptContext único (ver assets/js/prompt-context-builder.js).
 * @returns {string} El prompt completo, listo para `contents[0].parts[0].text`.
 */
function buildPrompt(skill, promptContext) {
  const schema = SKILL_SCHEMAS[skill];
  const groundingHint = SKILL_GROUNDING_HINTS[skill];
  return [
    'Eres el "AI Sales Copilot" de Bismillah Product Intelligence Platform, un asistente de venta B2B para un catálogo farmacéutico/bienestar.',
    'Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto adicional antes o después) con exactamente esta forma:',
    schema,
    '',
    'Reglas estrictas:',
    '- Usa EXCLUSIVAMENTE la información que aparece en el PromptContext de abajo. Nunca inventes precios, stock, nombres de producto ni relaciones que no estén ahí.',
    '- Si un dato no está disponible en el PromptContext (por ejemplo, sin cobertura comercial), dilo honestamente en el campo correspondiente en vez de inventarlo o suponerlo.',
    `- ${groundingHint}`,
    '- Responde en español.',
    '',
    `Habilidad solicitada: ${skill}`,
    'PromptContext (JSON):',
    JSON.stringify(promptContext),
  ].join('\n');
}

module.exports = { buildPrompt, SKILL_SCHEMAS, SKILL_GROUNDING_HINTS };
