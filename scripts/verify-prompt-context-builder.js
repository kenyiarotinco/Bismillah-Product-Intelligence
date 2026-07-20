/*
 * Smoke test headless para PromptContextBuilder (Fase 4, Paso 2).
 *
 * Carga data.js + context-builder.js + commercial-data-provider.js +
 * prompt-context-builder.js en un sandbox de Node (sin DOM, sin red) y
 * verifica el contrato de punta a punta: Context Builder -> PromptContext
 * estructurado, determinístico, sin campos undefined y sin duplicados.
 *
 * Uso: node scripts/verify-prompt-context-builder.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  data: path.join(ROOT, 'assets', 'js', 'data.js'),
  contextBuilder: path.join(ROOT, 'assets', 'js', 'context-builder.js'),
  commercialDataProvider: path.join(ROOT, 'assets', 'js', 'commercial-data-provider.js'),
  promptContextBuilder: path.join(ROOT, 'assets', 'js', 'prompt-context-builder.js'),
};

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Recorre recursivamente un valor y devuelve la ruta del primer `undefined`
// encontrado (en un valor de objeto, o dentro de un array), o null si no hay
// ninguno. JSON.stringify no sirve para esto: omite en silencio las claves
// con valor undefined en vez de señalarlas.
function findUndefined(value, pathStr) {
  if (value === undefined) return pathStr || '(root)';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUndefined(value[i], `${pathStr}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const found = findUndefined(value[k], pathStr ? `${pathStr}.${k}` : k);
      if (found) return found;
    }
    return null;
  }
  return null;
}

async function main() {
  await check('prompt-context-builder.js no referencia red/DOM/SDKs de IA en código ejecutable', () => {
    const banned = ['fetch(', 'XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const src = stripComments(fs.readFileSync(FILES.promptContextBuilder, 'utf8'));
    const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
    assert(hits.length === 0, `referencias prohibidas encontradas — ${hits.join(', ')}`);
  });

  await check('prompt-context-builder.js no referencia LocalResponseProvider ni AIResponseProvider (no genera respuestas, no elige proveedor)', () => {
    const src = fs.readFileSync(FILES.promptContextBuilder, 'utf8');
    assert(!/LocalResponseProvider|AIResponseProvider|ResponseProvider\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      'el módulo no debería acoplarse a ningún proveedor de respuestas');
  });

  // ---- carga en sandbox aislado, mismo orden que los <script> en index.html ----
  const sandbox = {};
  vm.createContext(sandbox);
  for (const key of ['data', 'contextBuilder', 'commercialDataProvider', 'promptContextBuilder']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('el módulo carga y expone build()/SCHEMA_VERSION', () => {
    assert(run('typeof PromptContextBuilder.build') === 'function', 'PromptContextBuilder.build debería ser una función');
    assert(typeof run('PromptContextBuilder.SCHEMA_VERSION') === 'string', 'SCHEMA_VERSION debería ser un string');
  });

  await check('build(context) devuelve exactamente los 6 bloques esperados por la especificación', () => {
    const keys = run(`
      (function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx);
        globalThis.__lastPC = pc;
        return Object.keys(pc).sort();
      })()
    `);
    const expected = ['alternatives', 'commercialContext', 'crossSell', 'productKnowledge', 'schemaVersion', 'userIntent'].sort();
    assert(JSON.stringify(keys) === JSON.stringify(expected), `estructura top-level inesperada: ${JSON.stringify(keys)}`);
  });

  await check('productKnowledge tiene exactamente los sub-bloques esperados', () => {
    const keys = run('Object.keys(__lastPC.productKnowledge).sort()');
    const expected = ['beneficios', 'familia', 'ingredientes', 'metadata', 'nombre', 'relaciones'].sort();
    assert(JSON.stringify(keys) === JSON.stringify(expected), `productKnowledge inesperado: ${JSON.stringify(keys)}`);
  });

  await check('commercialContext tiene exactamente los 6 campos esperados por la especificación (1.1.0: +priceDifference)', () => {
    const keys = run('Object.keys(__lastPC.commercialContext).sort()');
    const expected = ['disponibilidad', 'estado', 'precio', 'precioLista', 'priceDifference', 'stock'].sort();
    assert(JSON.stringify(keys) === JSON.stringify(expected), `commercialContext inesperado: ${JSON.stringify(keys)}`);
  });

  await check('ningún campo del PromptContext es undefined (recorrido profundo, no JSON.stringify)', () => {
    const found = run(`
      (function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx, { intent: { skill: 'explain-product' } });
        return JSON.stringify(${findUndefined.toString()}(pc, ''));
      })()
    `);
    assert(JSON.parse(found) === null, `se encontró un campo undefined en: ${found}`);
  });

  await check('beneficios/ingredientes se extraen correctamente de las justificaciones reales (no texto genérico)', () => {
    const ok = run(`
      (function () {
        // producto de prueba con relaciones MISMO_BENEFICIO y MISMO_INGREDIENTE reales
        const ctx = ContextBuilder.build(17, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx);
        const beneficiosReales = new Set();
        const ingredientesReales = new Set();
        for (const d of ctx.relaciones.detalle) {
          const m = /'([^']+)'/.exec(d.justificacion || '');
          if (!m) continue;
          if (d.tipo === 'MISMO_BENEFICIO') beneficiosReales.add(m[1]);
          if (d.tipo === 'MISMO_INGREDIENTE') ingredientesReales.add(m[1]);
        }
        const beneficiosOk = pc.productKnowledge.beneficios.every(b => beneficiosReales.has(b));
        const ingredientesOk = pc.productKnowledge.ingredientes.every(i => ingredientesReales.has(i));
        return beneficiosOk && ingredientesOk;
      })()
    `);
    assert(ok, 'algún beneficio/ingrediente citado en productKnowledge no proviene de una justificación real de ese producto');
  });

  await check('alternatives/crossSell no contienen skus duplicados (un candidato agrupa TODAS sus relaciones elegibles, aparece una sola vez)', () => {
    const ok = run(`
      (function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx);
        const uniqAlt = new Set(pc.alternatives.map(a => a.sku));
        const uniqCross = new Set(pc.crossSell.map(c => c.sku));
        return uniqAlt.size === pc.alternatives.length && uniqCross.size === pc.crossSell.length;
      })()
    `);
    assert(ok, 'se encontró un sku duplicado en alternatives o crossSell');
  });

  await check('alternatives/crossSell nunca incluyen una relación de confianza Baja (política R-PIG-04 reaplicada)', () => {
    const ok = run(`
      (function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx);
        const todas = [...pc.alternatives, ...pc.crossSell].flatMap(c => c.relaciones);
        return todas.every(r => r.confianza !== 'Baja');
      })()
    `);
    assert(ok, 'alternatives/crossSell no deberían incluir nunca una relación de confianza Baja');
  });

  await check('alternatives contiene únicamente candidatos SUSTITUYE; crossSell únicamente los 4 tipos elegibles de venta cruzada', () => {
    const ok = run(`
      (function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx);
        const crossTypes = ['COMPLEMENTA', 'MISMO_BENEFICIO', 'MISMA_AUDIENCIA', 'MISMO_INGREDIENTE'];
        const altOk = pc.alternatives.every(a => a.relaciones.every(r => r.tipo === 'SUSTITUYE'));
        const crossOk = pc.crossSell.every(c => c.relaciones.every(r => crossTypes.includes(r.tipo)));
        return altOk && crossOk;
      })()
    `);
    assert(ok, 'alternatives/crossSell contienen un tipo de relación fuera de lo esperado para ese bloque');
  });

  await check('userIntent se relaya tal cual cuando se provee, y queda en null cuando se omite (nunca se infiere)', () => {
    const withIntent = run(`
      (function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const pc = PromptContextBuilder.build(ctx, { intent: { skill: 'compare-products', query: 'colágeno' } });
        return JSON.stringify(pc.userIntent);
      })()
    `);
    assert(JSON.parse(withIntent).skill === 'compare-products', 'userIntent debería relayar exactamente el objeto pasado en options.intent');

    const withoutIntent = run(`
      (function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const pc = PromptContextBuilder.build(ctx);
        return pc.userIntent;
      })()
    `);
    assert(withoutIntent === null, 'userIntent debería ser null cuando no se provee options.intent');
  });

  await check('commercialContext relaya fielmente comercial.disponible=false (perfil sin cobertura comercial)', () => {
    const ok = run(`
      (function () {
        // ninguna cobertura comercial cargada en este sandbox — comercial.disponible siempre false
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const pc = PromptContextBuilder.build(ctx);
        return pc.commercialContext.disponibilidad === false
          && pc.commercialContext.precio === null
          && pc.commercialContext.precioLista === null
          && pc.commercialContext.priceDifference === null
          && pc.commercialContext.stock === null
          && pc.commercialContext.estado === null;
      })()
    `);
    assert(ok, 'commercialContext debería reflejar honestamente la ausencia de dato comercial, sin fabricar ningún valor');
  });

  await check('commercialContext relaya fielmente comercial.disponible=true (con un proveedor comercial simulado)', () => {
    const ok = run(`
      (function () {
        const provider = { getBySku: () => ({ precio: 39.90, precioLista: 45.00, stock: 120, estado: 'Disponible', priceDifference: 5.10 }) };
        const ctx = ContextBuilder.build(0, { maxPerType: 15, commercialProvider: provider });
        const pc = PromptContextBuilder.build(ctx);
        return pc.commercialContext.disponibilidad === true
          && pc.commercialContext.precio === 39.90
          && pc.commercialContext.precioLista === 45.00
          && pc.commercialContext.priceDifference === 5.10
          && pc.commercialContext.stock === 120
          && pc.commercialContext.estado === 'Disponible';
      })()
    `);
    assert(ok, 'commercialContext debería relayar fielmente un dato comercial real disponible, incluyendo priceDifference (1.1.0)');
  });

  await check('contexto inválido lanza sincrónicamente (error de programación, no un caso esperado)', () => {
    const threwNull = run(`
      (function () { try { PromptContextBuilder.build(null); return false; } catch (e) { return true; } })()
    `);
    const threwPartial = run(`
      (function () { try { PromptContextBuilder.build({ producto: {} }); return false; } catch (e) { return true; } })()
    `);
    assert(threwNull, 'PromptContextBuilder.build(null) debería lanzar');
    assert(threwPartial, 'PromptContextBuilder.build(contexto incompleto) debería lanzar');
  });

  await check('llamadas repetidas con el mismo producto son puras (no acumulan estado entre llamadas)', () => {
    const equal = run(`
      (function () {
        const ctx = ContextBuilder.build(17, { maxPerType: 300 });
        const a = JSON.stringify(PromptContextBuilder.build(ctx));
        const b = JSON.stringify(PromptContextBuilder.build(ctx));
        return a === b;
      })()
    `);
    assert(equal, 'dos llamadas con el mismo context deberían producir el mismo PromptContext (salvo timestamps, que ya vienen fijos en el context de entrada)');
  });

  await check('recorre TODO el catálogo sin lanzar, sin campos undefined y sin skus duplicados en alternatives/crossSell (robustez)', () => {
    const n = run('DATA.products.length');
    const bad = run(`
      (function () {
        const fallos = [];
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { maxPerType: 300 });
            const pc = PromptContextBuilder.build(ctx);
            const undef = (${findUndefined.toString()})(pc, '');
            if (undef) fallos.push({ i, motivo: 'undefined en ' + undef });
            const uniqAlt = new Set(pc.alternatives.map(a => a.sku));
            const uniqCross = new Set(pc.crossSell.map(c => c.sku));
            if (uniqAlt.size !== pc.alternatives.length) fallos.push({ i, motivo: 'sku duplicado en alternatives' });
            if (uniqCross.size !== pc.crossSell.length) fallos.push({ i, motivo: 'sku duplicado en crossSell' });
          } catch (e) { fallos.push({ i, motivo: e.message }); }
        }
        return fallos;
      })()
    `);
    assert(Array.isArray(bad) && bad.length === 0, `${bad.length} fallo(s): ${JSON.stringify(bad.slice(0, 5))}`);
    return `${n} productos verificados`;
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
    console.log('ALL PROMPT CONTEXT BUILDER CHECKS PASSED');
  }
}

main();
