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
 *
 * Fase 2, Paso 4: implementa también `compareProducts(contextA, contextB)`,
 * con el mismo enfoque — sin IA, sin red, solo reglas sobre los campos que
 * ya entrega ContextBuilder para cada producto — y reutilizando (no
 * duplicando) el vocabulario y la extracción de beneficios ya definidos más
 * abajo para explainProduct().
 *
 * Fase 2, Paso 5: implementa también `bestAlternative(context)` — encuentra,
 * dentro de las relaciones SUSTITUYE que ya trae el contexto del producto
 * actual, la de mayor confianza (excluyendo Baja, misma política R-PIG-04
 * que ya aplican Panorama y Motores) y arma su justificación reutilizando
 * collectBenefits()/labelFor() — sin una segunda llamada a ContextBuilder.
 *
 * Fase 2, Paso 6: implementa también `crossSell(context)` — reaplica (sin
 * duplicar su código) el mismo criterio de negocio que ya usa el motor de
 * "Venta cruzada" en Motores (COMPLEMENTA > MISMO_BENEFICIO >
 * MISMA_AUDIENCIA > MISMO_INGREDIENTE, ponderado por confianza, Baja
 * excluida por defecto) sobre las relaciones que ya trae el contexto del
 * producto actual, reutilizando labelFor() para las justificaciones.
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

  // ---------- compareProducts: helpers propios, reutilizan labelFor()/
  // extractQuoted()/collectBenefits() ya definidos arriba — no se duplica
  // ningún vocabulario ni técnica de extracción para esta habilidad. ----------

  function summarizeForCompare(context) {
    const { producto, relaciones } = context;
    return {
      sku: producto.sku,
      nombre: producto.nombre,
      universo: producto.universo,
      categoria: producto.subcategoria,
      beneficios: collectBenefits(relaciones.detalle),
      etiquetas: producto.tags,
      relaciones: { total: relaciones.total, porTipo: relaciones.porTipo },
    };
  }

  function intersect(a, b) {
    return a.filter(x => b.includes(x));
  }
  function onlyIn(a, b) {
    return a.filter(x => !b.includes(x));
  }

  // Un hecho real, no inferido: ¿aparece B explícitamente entre las
  // relaciones de A (o A entre las de B)? Depende de que el contexto se haya
  // construido con un maxPerType suficientemente alto como para no truncar
  // antes de llegar al otro producto — responsabilidad de quien orquesta la
  // llamada (ver COMPARE_MAX_PER_TYPE en app.js).
  function findDirectRelation(contextFrom, contextTo) {
    const match = contextFrom.relaciones.detalle.find(d => d.sku === contextTo.producto.sku);
    if (!match) return null;
    return { tipo: match.tipo, confianza: match.confianza, justificacion: match.justificacion };
  }

  function buildComparison(contextA, contextB) {
    const a = summarizeForCompare(contextA);
    const b = summarizeForCompare(contextB);
    const directa = findDirectRelation(contextA, contextB) || findDirectRelation(contextB, contextA);

    const similitudes = [];
    const diferencias = [];

    if (a.universo && b.universo && a.universo === b.universo) {
      similitudes.push(`Ambos pertenecen al universo ${a.universo}.`);
    } else if (a.universo && b.universo) {
      diferencias.push(`Universos distintos: "${a.nombre}" es ${a.universo}, "${b.nombre}" es ${b.universo}.`);
    }

    if (a.categoria && b.categoria && a.categoria === b.categoria) {
      similitudes.push(`Comparten la misma subcategoría: "${a.categoria}".`);
    } else if (a.categoria && b.categoria) {
      diferencias.push(`Subcategorías distintas: "${a.categoria}" vs "${b.categoria}".`);
    }

    const beneficiosComunes = intersect(a.beneficios, b.beneficios);
    if (beneficiosComunes.length) {
      similitudes.push(`Beneficios en común: ${beneficiosComunes.join(', ')}.`);
    }
    const beneficiosSoloA = onlyIn(a.beneficios, b.beneficios);
    const beneficiosSoloB = onlyIn(b.beneficios, a.beneficios);
    if (beneficiosSoloA.length) diferencias.push(`Solo "${a.nombre}" aporta: ${beneficiosSoloA.join(', ')}.`);
    if (beneficiosSoloB.length) diferencias.push(`Solo "${b.nombre}" aporta: ${beneficiosSoloB.join(', ')}.`);

    const etiquetasComunes = intersect(a.etiquetas, b.etiquetas);
    if (etiquetasComunes.length) {
      similitudes.push(`Etiquetas en común: ${etiquetasComunes.join(', ')}.`);
    }

    if (directa) {
      similitudes.push(
        `Están directamente relacionados en el grafo del catálogo (${labelFor(directa.tipo)}, confianza ${directa.confianza}): ${directa.justificacion}.`
      );
    } else {
      diferencias.push('No hay una relación directa registrada entre estos dos productos en el catálogo.');
    }

    if (Math.abs(a.relaciones.total - b.relaciones.total) >= 10) {
      const mayor = a.relaciones.total >= b.relaciones.total ? a : b;
      const menor = mayor === a ? b : a;
      diferencias.push(
        `"${mayor.nombre}" tiene muchas más relaciones registradas en el catálogo que "${menor.nombre}" (${mayor.relaciones.total} vs ${menor.relaciones.total}).`
      );
    }

    return { productos: { a, b }, similitudes, diferencias };
  }

  // ---------- bestAlternative: reutiliza collectBenefits() ya definido
  // arriba para explainProduct() — ninguna técnica de extracción nueva. ----------

  // relaciones.detalle ya llega ordenado con confianza Alta antes que Media
  // antes que Baja (ver ContextBuilder.buildDetail, docs/ARCHITECTURE.md
  // Paso 2) — filtrar SUSTITUYE y excluir Baja (política R-PIG-04, la misma
  // que ya aplican Panorama y el motor de "Sustitución" en Motores) y tomar
  // el primero da directamente el candidato de mayor confianza disponible,
  // sin necesidad de reordenar nada aquí.
  function pickBestSubstitute(detalle) {
    return detalle.find(d => d.tipo === 'SUSTITUYE' && d.confianza !== 'Baja') || null;
  }

  function buildBestAlternative(context) {
    const { producto, relaciones } = context;
    const mejor = pickBestSubstitute(relaciones.detalle);

    if (!mejor) {
      return {
        encontrado: false,
        alternativa: null,
        afinidad: null,
        justificacion: null,
        mensaje: `No se encontró un sustituto con confianza suficiente para "${producto.nombre}" en el catálogo.`,
      };
    }

    const razones = [];
    razones.push(
      `"${mejor.nombre}" fue identificado como el mejor sustituto de "${producto.nombre}" (confianza ${mejor.confianza}): ${mejor.justificacion}.`
    );
    if (producto.subcategoria) {
      razones.push(`"${producto.nombre}" pertenece a la subcategoría "${producto.subcategoria}".`);
    }
    const beneficios = collectBenefits(relaciones.detalle);
    if (beneficios.length) {
      razones.push(`Beneficios que "${producto.nombre}" aporta en el catálogo: ${beneficios.join(', ')}.`);
    }
    if (producto.tags.length) {
      razones.push(`Etiquetas de "${producto.nombre}": ${producto.tags.join(', ')}.`);
    }

    return {
      encontrado: true,
      alternativa: { sku: mejor.sku, nombre: mejor.nombre },
      afinidad: mejor.confianza,
      justificacion: razones.join('\n\n'),
      mensaje: null,
    };
  }

  // ---------- crossSell: reutiliza labelFor() ya definido arriba — ningún
  // vocabulario nuevo. Los pesos reaplican, sin copiar su código, el mismo
  // criterio de negocio que ya usa engineRecos() para la pestaña "Venta
  // cruzada" del motor en Motores (app.js): COMPLEMENTA > MISMO_BENEFICIO >
  // MISMA_AUDIENCIA > MISMO_INGREDIENTE, ponderado por confianza. Mantener
  // este proveedor independiente de app.js (ver Paso 2/3) significa que no
  // se puede *importar* CROSS_TYPE_W/CONF_W desde ahí — se reexpresa aquí el
  // mismo criterio, ya validado y en producción en Motores, no uno nuevo. ----------

  const CROSS_SELL_TYPE_WEIGHT = {
    COMPLEMENTA: 3.0,
    MISMO_BENEFICIO: 2.0,
    MISMA_AUDIENCIA: 1.5,
    MISMO_INGREDIENTE: 1.0,
  };
  const CROSS_SELL_CONF_WEIGHT = { Alta: 1.0, Media: 0.6 }; // Baja excluida — política R-PIG-04
  const CROSS_SELL_MAX_RESULTS = 5;

  function crossSellWeight(d) {
    const typeW = CROSS_SELL_TYPE_WEIGHT[d.tipo];
    const confW = CROSS_SELL_CONF_WEIGHT[d.confianza];
    return typeW === undefined || confW === undefined ? null : typeW * confW;
  }

  function buildCrossSell(context) {
    const { producto, relaciones } = context;
    const candidatos = new Map(); // sku -> { sku, nombre, score, relaciones: [] }

    for (const d of relaciones.detalle) {
      const peso = crossSellWeight(d);
      if (peso === null) continue;
      if (!candidatos.has(d.sku)) candidatos.set(d.sku, { sku: d.sku, nombre: d.nombre, score: 0, relaciones: [] });
      const c = candidatos.get(d.sku);
      c.score += peso;
      c.relaciones.push(d);
    }

    // Relevancia: score agregado (varias relaciones elegibles al mismo
    // candidato se refuerzan entre sí), luego cantidad de señales distintas,
    // luego orden alfabético — determinista, sin datos fabricados para
    // desempatar.
    const ordenados = [...candidatos.values()].sort((a, b) =>
      b.score - a.score || b.relaciones.length - a.relaciones.length || a.nombre.localeCompare(b.nombre)
    );
    const top = ordenados.slice(0, CROSS_SELL_MAX_RESULTS);

    if (!top.length) {
      return {
        recomendaciones: [],
        mensaje: `No se encontraron productos complementarios elegibles para "${producto.nombre}" en el catálogo.`,
      };
    }

    const recomendaciones = top.map(c => {
      const relOrdenadas = [...c.relaciones].sort((a, b) => crossSellWeight(b) - crossSellWeight(a));
      const principal = relOrdenadas[0];
      let razon = `${labelFor(principal.tipo)} (confianza ${principal.confianza}): ${principal.justificacion}.`;
      const otrosTipos = [...new Set(relOrdenadas.slice(1).map(r => labelFor(r.tipo)))];
      if (otrosTipos.length) razon += ` También comparte: ${otrosTipos.join(', ')}.`;
      return { sku: c.sku, nombre: c.nombre, razon };
    });

    return { recomendaciones, mensaje: null };
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

  function compareProducts(contextA, contextB) {
    if (!contextA || !contextA.producto || !contextA.relaciones) {
      return Promise.reject(new Error('LocalResponseProvider.compareProducts: contexto del producto A inválido o incompleto.'));
    }
    if (!contextB || !contextB.producto || !contextB.relaciones) {
      return Promise.reject(new Error('LocalResponseProvider.compareProducts: contexto del producto B inválido o incompleto.'));
    }
    return Promise.resolve({
      skill: 'compare-products',
      source: SOURCE,
      generatedAt: new Date().toISOString(),
      ...buildComparison(contextA, contextB),
    });
  }

  function bestAlternative(context) {
    if (!context || !context.producto || !context.relaciones) {
      return Promise.reject(new Error('LocalResponseProvider.bestAlternative: contexto inválido o incompleto.'));
    }
    return Promise.resolve({
      skill: 'best-alternative',
      source: SOURCE,
      generatedAt: new Date().toISOString(),
      ...buildBestAlternative(context),
    });
  }

  function crossSell(context) {
    if (!context || !context.producto || !context.relaciones) {
      return Promise.reject(new Error('LocalResponseProvider.crossSell: contexto inválido o incompleto.'));
    }
    return Promise.resolve({
      skill: 'cross-sell',
      source: SOURCE,
      generatedAt: new Date().toISOString(),
      ...buildCrossSell(context),
    });
  }

  return { explainProduct, compareProducts, bestAlternative, crossSell };
})();
