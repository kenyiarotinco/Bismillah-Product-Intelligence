/*
 * Smoke test headless para server/gemini-prompt-builder.js (Fase 4, Paso 5).
 *
 * Verifica que el prompt final incluye, para cada una de las 5 habilidades:
 * el schema de salida esperado, la regla genérica de no inventar datos, y
 * la instrucción de grounding ESPECÍFICA de esa habilidad — en particular,
 * que "Mejor alternativa" y "Venta cruzada" instruyen explícitamente al
 * modelo a no elegir un candidato fuera de las listas ya filtradas por
 * PromptContextBuilder (R-PIG-04).
 *
 * Uso: node scripts/verify-gemini-prompt-builder.js
 */
'use strict';
const { buildPrompt, SKILL_SCHEMAS, SKILL_GROUNDING_HINTS } = require('../server/gemini-prompt-builder.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true, detail: '' });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ALL_SKILLS = ['explain-product', 'compare-products', 'best-alternative', 'cross-sell', 'price-availability'];

function main() {
  check('define exactamente las 5 habilidades del contrato, ni de más ni de menos, en schema y en grounding hints', () => {
    assert(Object.keys(SKILL_SCHEMAS).sort().join(',') === [...ALL_SKILLS].sort().join(','), 'SKILL_SCHEMAS no coincide con las 5 habilidades esperadas');
    assert(Object.keys(SKILL_GROUNDING_HINTS).sort().join(',') === [...ALL_SKILLS].sort().join(','), 'SKILL_GROUNDING_HINTS no coincide con las 5 habilidades esperadas');
  });

  for (const skill of ALL_SKILLS) {
    check(`buildPrompt("${skill}"): incluye el skill solicitado, el schema de salida y la regla genérica de no inventar datos`, () => {
      const prompt = buildPrompt(skill, { productKnowledge: { nombre: 'Producto X' } });
      assert(prompt.includes(`Habilidad solicitada: ${skill}`), 'el prompt debería declarar explícitamente el skill solicitado');
      assert(prompt.includes(SKILL_SCHEMAS[skill]), 'el prompt debería incluir el schema JSON exacto esperado para este skill');
      assert(/nunca inventes/i.test(prompt), 'el prompt debería incluir la regla genérica de no inventar datos');
      assert(prompt.includes('Producto X'), 'el prompt debería incluir el contenido real del PromptContext recibido');
    });

    check(`buildPrompt("${skill}"): incluye su propia instrucción de grounding específica (no la de otra habilidad)`, () => {
      const prompt = buildPrompt(skill, {});
      assert(prompt.includes(SKILL_GROUNDING_HINTS[skill]), 'el prompt debería incluir la instrucción de grounding específica de este skill');
      const otras = ALL_SKILLS.filter(s => s !== skill);
      for (const otro of otras) {
        assert(!prompt.includes(SKILL_GROUNDING_HINTS[otro]), `el prompt de "${skill}" no debería incluir la instrucción de grounding de "${otro}"`);
      }
    });
  }

  check('best-alternative: la instrucción de grounding prohíbe explícitamente elegir fuera de "alternatives"', () => {
    const hint = SKILL_GROUNDING_HINTS['best-alternative'];
    assert(/alternatives/.test(hint), 'debería nombrar explícitamente el bloque "alternatives"');
    assert(/nunca sugieras/i.test(hint), 'debería prohibir explícitamente sugerir algo fuera de esa lista');
  });

  check('cross-sell: la instrucción de grounding prohíbe explícitamente agregar candidatos fuera de "crossSell"', () => {
    const hint = SKILL_GROUNDING_HINTS['cross-sell'];
    assert(/crossSell/.test(hint), 'debería nombrar explícitamente el bloque "crossSell"');
    assert(/nunca agregues/i.test(hint), 'debería prohibir explícitamente agregar algo fuera de esa lista');
  });

  check('price-availability: la instrucción de grounding exige consistencia con commercialContext.disponibilidad', () => {
    const hint = SKILL_GROUNDING_HINTS['price-availability'];
    assert(/disponibilidad/.test(hint), 'debería nombrar explícitamente el campo "disponibilidad"');
    assert(/null/.test(hint), 'debería exigir null en los campos numéricos cuando no hay disponibilidad');
  });

  check('compare-products: la instrucción de grounding explica la estructura de dos productos independientes (a/b)', () => {
    const hint = SKILL_GROUNDING_HINTS['compare-products'];
    assert(hint.includes('"a"') && hint.includes('"b"'), 'debería mencionar explícitamente las claves "a" y "b"');
  });

  check('el prompt es determinístico: mismo skill + mismo PromptContext producen el mismo prompt', () => {
    const ctx = { productKnowledge: { nombre: 'Estable' }, alternatives: [] };
    const a = buildPrompt('best-alternative', ctx);
    const b = buildPrompt('best-alternative', ctx);
    assert(a === b, 'buildPrompt debería ser una función pura');
  });

  check('un skill desconocido no lanza — produce un prompt con schema/hint "undefined" en vez de crashear (el caller ya valida el skill antes de llegar aquí)', () => {
    const prompt = buildPrompt('skill-inexistente', {});
    assert(typeof prompt === 'string' && prompt.length > 0, 'no debería lanzar ante un skill desconocido');
  });

  // ---- reporte ----
  const failed = results.filter(r => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks OK`);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) fallaron.`);
    process.exit(1);
  } else {
    console.log('ALL GEMINI PROMPT BUILDER CHECKS PASSED');
  }
}

main();
