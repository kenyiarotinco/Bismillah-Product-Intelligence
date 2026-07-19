/* Bismillah Product Intelligence Platform — Local Response Provider (Fase 2, Paso 3)
 *
 * Implementación LOCAL (sin red, sin SDK de IA) del contrato definido en
 * response-provider.js. Sintetiza texto por reglas y plantillas a partir,
 * exclusivamente, de los campos que ya devuelve ContextBuilder.build() —
 * nunca inventa datos: si un campo no está disponible (p. ej.
 * comercial.precio, hoy siempre null), el texto simplemente lo omite o lo
 * declara pendiente, nunca lo simula.
 *
 * Es intercambiable por un proveedor real (Gemini u otro) sin que el panel
 * del Copilot, ContextBuilder o Producto 360 cambien una sola línea: ambos
 * cumplen exactamente el mismo contrato async `explainProduct(context) =>
 * Promise<{skill, source, generatedAt, text}>`. El día que exista un
 * GeminiResponseProvider con esa misma forma, el único cambio en todo el
 * sistema es la línea `ResponseProvider.use(...)` en app.js.
 */
'use strict';

const LocalResponseProvider = (function () {
  const SOURCE = 'local';

  // Vocabulario de presentación propio de este proveedor — no de
  // ContextBuilder, que deliberadamente solo expone las claves crudas de
  // relación (p. ej. "MISMO_BENEFICIO"), no sus rótulos en español. Es la
  // misma decisión ya documentada para `familiaCodigo` en el Paso 2
  // (docs/ARCHITECTURE.md): mantener este proveedor 100% independiente de
  // app.js, incluso a costa de duplicar un pequeño diccionario estable de 7
  // entradas que también existe como TYPE_META en app.js.
  const TYPE_LABELS = {
    MISMA_CATEGORIA: 'misma categoría',
    MISMO_BENEFICIO: 'mismo beneficio',
    MISMO_INGREDIENTE: 'mismo ingrediente',
    SUSTITUYE: 'sustitución',
    COMPLEMENTA: 'complemento',
    MISMA_AUDIENCIA: 'misma audiencia',
    VARIANTE: 'variante',
  };

  function labelFor(tipo) {
    return TYPE_LABELS[tipo] || tipo;
  }

  // Las justificaciones de MISMO_BENEFICIO siguen, en el 100% de los casos
  // verificados (sintético y real — ver scripts/verify-response-provider.js),
  // el patrón "Ambos aportan al beneficio 'X' desde subcategorías distintas".
  // Extraer el nombre entre comillas no es inventar un dato: es leer un dato
  // que ya existe, literal, en el texto que ContextBuilder ya entregó.
  function extractQuoted(text) {
    const m = /'([^']+)'/.exec(text || '');
    return m ? m[1] : null;
  }

  function collectBenefits(detalle) {
    const benefits = new Set();
    for (const d of detalle) {
      if (d.tipo !== 'MISMO_BENEFICIO') continue;
      const b = extractQuoted(d.justificacion);
      if (b) benefits.add(b);
    }
    return [...benefits];
  }

  function pickExample(detalle) {
    return (
      detalle.find(d => d.tipo === 'SUSTITUYE') ||
      detalle.find(d => d.tipo === 'COMPLEMENTA') ||
      detalle.find(d => d.tipo === 'MISMO_INGREDIENTE') ||
      detalle[0] ||
      null
    );
  }

  function buildText(context) {
    const { producto, relaciones, comercial } = context;
    const parrafos = [];

    let intro = `${producto.nombre} pertenece al universo ${producto.universo || 'sin clasificar'}`;
    if (producto.subcategoria) intro += `, en la subcategoría "${producto.subcategoria}"`;
    intro += '.';
    parrafos.push(intro);

    const beneficios = collectBenefits(relaciones.detalle);
    if (beneficios.length) {
      parrafos.push(`Beneficios asociados en el catálogo: ${beneficios.join(', ')}.`);
    }

    if (producto.audiencias.length) {
      parrafos.push(`Público objetivo: ${producto.audiencias.join(', ')}.`);
    }

    if (producto.tags.length) {
      parrafos.push(`Se identifica con las etiquetas: ${producto.tags.join(', ')}.`);
    }

    if (relaciones.total > 0) {
      const resumen = relaciones.porTipo.map(r => `${r.cantidad} de ${labelFor(r.tipo)}`).join(', ');
      parrafos.push(`Tiene ${relaciones.total} relaciones registradas en el grafo del catálogo: ${resumen}.`);
    } else {
      parrafos.push('Todavía no tiene relaciones registradas en el catálogo.');
    }

    const ejemplo = pickExample(relaciones.detalle);
    if (ejemplo) {
      parrafos.push(
        `Por ejemplo, respecto a "${ejemplo.nombre}" (${labelFor(ejemplo.tipo)}, confianza ${ejemplo.confianza}): ${ejemplo.justificacion}.`
      );
    }

    if (!comercial.disponible) {
      parrafos.push(
        `Precio, stock, margen y estado todavía no están disponibles para este producto — se incorporarán cuando finalice la ${comercial.pendienteDe}.`
      );
    }

    return parrafos.join('\n\n');
  }

  function explainProduct(context) {
    if (!context || !context.producto || !context.relaciones || !context.comercial) {
      return Promise.reject(new Error('LocalResponseProvider.explainProduct: contexto inválido o incompleto.'));
    }
    return Promise.resolve({
      skill: 'explain-product',
      source: SOURCE,
      generatedAt: new Date().toISOString(),
      text: buildText(context),
    });
  }

  return { explainProduct };
})();
