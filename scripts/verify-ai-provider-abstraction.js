/*
 * Smoke test headless para Fase 4, Paso 1 — Abstracción de Proveedores de IA
 * (contrato/registro) — actualizado en Fase 5, Paso 1 para reflejar que
 * AIResponseProvider dejó de ser un placeholder que siempre rechaza.
 *
 * Verifica el contrato común (response-provider-contract.js), que
 * LocalResponseProvider lo sigue cumpliendo sin haber sido modificado, que
 * AIResponseProvider cumple el mismo contrato (hoy delegando en
 * RemoteResponseProvider — ver scripts/verify-ai-response-provider.js para
 * el comportamiento real de esa delegación, fuera de alcance de este
 * archivo), y que ResponseProvider (el registro/puerto) acepta ambos
 * proveedores sin cambiar su comportamiento previo. Todo se carga en un
 * sandbox de Node (sin DOM, sin red real), en el mismo orden que los
 * <script> de index.html.
 *
 * Uso: node scripts/verify-ai-provider-abstraction.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  data: path.join(ROOT, 'assets', 'js', 'data.js'),
  contextBuilder: path.join(ROOT, 'assets', 'js', 'context-builder.js'),
  promptContextBuilder: path.join(ROOT, 'assets', 'js', 'prompt-context-builder.js'),
  commercialDataProvider: path.join(ROOT, 'assets', 'js', 'commercial-data-provider.js'),
  featureFlags: path.join(ROOT, 'assets', 'js', 'feature-flags.js'),
  responseProviderContract: path.join(ROOT, 'assets', 'js', 'response-provider-contract.js'),
  responseProvider: path.join(ROOT, 'assets', 'js', 'response-provider.js'),
  localProvider: path.join(ROOT, 'assets', 'js', 'providers', 'local-response-provider.js'),
  remoteProvider: path.join(ROOT, 'assets', 'js', 'providers', 'remote-response-provider.js'),
  aiProvider: path.join(ROOT, 'assets', 'js', 'providers', 'ai-response-provider.js'),
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

async function main() {
  await check('ningún archivo de este paso referencia DOM/SDKs de IA en código ejecutable (fetch SÍ es esperado, vía RemoteResponseProvider)', () => {
    const banned = ['XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = [];
    for (const key of ['responseProviderContract', 'responseProvider', 'localProvider', 'aiProvider']) {
      const src = stripComments(fs.readFileSync(FILES[key], 'utf8'));
      const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
      if (hits.length) offenders.push(`${key}: ${hits.join(', ')}`);
    }
    assert(offenders.length === 0, `referencias prohibidas encontradas — ${offenders.join(' | ')}`);
  });

  await check('ai-response-provider.js no reimplementa ninguna lógica de transporte — es un delegado puro (por inspección de código ejecutable, sin comentarios)', () => {
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const src = stripComments(fs.readFileSync(FILES.aiProvider, 'utf8'));
    assert(!/\bfetch\s*\(/.test(src), 'AIResponseProvider no debería llamar a fetch() directamente — eso es responsabilidad exclusiva de RemoteResponseProvider');
    assert(!/PromptContextBuilder/.test(src), 'AIResponseProvider no debería referenciar PromptContextBuilder directamente (en código, fuera de comentarios) — la conversión Context→PromptContext ocurre solo dentro de RemoteResponseProvider');
    assert(/RemoteResponseProvider\./.test(src), 'AIResponseProvider debería delegar explícitamente en RemoteResponseProvider');
  });

  const sandbox = {};
  vm.createContext(sandbox);
  // RemoteResponseProvider (cargado transitivamente por AIResponseProvider
  // desde este paso) usa setTimeout/AbortController para su timeout — un
  // vm.createContext() vacío no los trae por defecto (ver el bug real
  // encontrado y corregido en verify-remote-response-provider.js, Fase 4
  // Paso 4); se inyectan aquí por la misma razón, aunque ningún check de
  // este archivo llegue a ejercitar esa ruta con el flag desactivado.
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.AbortController = AbortController;
  for (const key of ['data', 'contextBuilder', 'promptContextBuilder', 'commercialDataProvider', 'featureFlags', 'responseProviderContract', 'responseProvider', 'localProvider', 'remoteProvider', 'aiProvider']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('ResponseProviderContract define las 5 habilidades esperadas', () => {
    const methods = run('ResponseProviderContract.METHODS');
    const expected = ['explainProduct', 'compareProducts', 'bestAlternative', 'crossSell', 'priceAndAvailability'];
    assert(Array.isArray(methods) && methods.length === expected.length && expected.every(m => methods.includes(m)),
      `METHODS no coincide con lo esperado: ${JSON.stringify(methods)}`);
  });

  await check('missingMethods()/implementedBy() reportan correctamente sobre un objeto vacío, parcial y completo', () => {
    const empty = run('ResponseProviderContract.missingMethods({})');
    assert(Array.isArray(empty) && empty.length === 5, 'un objeto vacío debería reportar las 5 faltantes');
    assert(run('ResponseProviderContract.implementedBy({})') === false, 'un objeto vacío no debería cumplir el contrato');

    const partial = run(`ResponseProviderContract.missingMethods({ explainProduct: () => {}, compareProducts: () => {} })`);
    assert(Array.isArray(partial) && partial.length === 3
      && partial.includes('bestAlternative') && partial.includes('crossSell') && partial.includes('priceAndAvailability'),
      `faltantes incorrectas para un proveedor parcial: ${JSON.stringify(partial)}`);

    const full = run(`ResponseProviderContract.missingMethods({
      explainProduct: () => {}, compareProducts: () => {}, bestAlternative: () => {},
      crossSell: () => {}, priceAndAvailability: () => {},
    })`);
    assert(Array.isArray(full) && full.length === 0, 'un objeto con los 5 métodos no debería reportar faltantes');
  });

  await check('missingMethods(null/undefined) no lanza y reporta las 5 como faltantes', () => {
    assert(run('ResponseProviderContract.missingMethods(null).length === 5'), 'missingMethods(null) debería devolver las 5 faltantes, no lanzar');
    assert(run('ResponseProviderContract.missingMethods(undefined).length === 5'), 'missingMethods(undefined) debería devolver las 5 faltantes, no lanzar');
    assert(run('ResponseProviderContract.implementedBy(null) === false'), 'implementedBy(null) debería ser false');
  });

  await check('LocalResponseProvider cumple el contrato sin haber sido modificado (verificado dinámicamente, no por inspección)', () => {
    assert(run('ResponseProviderContract.implementedBy(LocalResponseProvider) === true'),
      `LocalResponseProvider no cumple el contrato — faltan: ${run('JSON.stringify(ResponseProviderContract.missingMethods(LocalResponseProvider))')}`);
  });

  await check('AIResponseProvider existe y cumple el mismo contrato (Fase 5, Paso 1: implementación real, delega en RemoteResponseProvider)', () => {
    assert(typeof run('AIResponseProvider') === 'object', 'AIResponseProvider debería existir como objeto global');
    assert(run('ResponseProviderContract.implementedBy(AIResponseProvider) === true'),
      `AIResponseProvider no cumple el contrato — faltan: ${run('JSON.stringify(ResponseProviderContract.missingMethods(AIResponseProvider))')}`);
  });

  await check('cada método de AIResponseProvider resuelve (delega en RemoteResponseProvider, que cae a Local con el flag desactivado — nunca queda una Promise sin resolver)', async () => {
    const outcomes = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const out = {};
        out.explainProduct = (await AIResponseProvider.explainProduct(ctxA)).skill;
        out.compareProducts = (await AIResponseProvider.compareProducts(ctxA, ctxB)).skill;
        out.bestAlternative = (await AIResponseProvider.bestAlternative(ctxA)).skill;
        out.crossSell = (await AIResponseProvider.crossSell(ctxA)).skill;
        out.priceAndAvailability = (await AIResponseProvider.priceAndAvailability(ctxA)).skill;
        return JSON.stringify(out);
      })()
    `);
    const parsed = JSON.parse(outcomes);
    assert(parsed.explainProduct === 'explain-product', 'AIResponseProvider.explainProduct debería resolver con skill:"explain-product"');
    assert(parsed.compareProducts === 'compare-products', 'AIResponseProvider.compareProducts debería resolver con skill:"compare-products"');
    assert(parsed.bestAlternative === 'best-alternative', 'AIResponseProvider.bestAlternative debería resolver con skill:"best-alternative"');
    assert(parsed.crossSell === 'cross-sell', 'AIResponseProvider.crossSell debería resolver con skill:"cross-sell"');
    assert(parsed.priceAndAvailability === 'price-availability', 'AIResponseProvider.priceAndAvailability debería resolver con skill:"price-availability"');
  });

  await check('ResponseProvider.use() acepta tanto a LocalResponseProvider como a AIResponseProvider (ambos son proveedores válidos)', () => {
    run('ResponseProvider.use(AIResponseProvider);');
    assert(run('ResponseProvider.get() === AIResponseProvider'), 'ResponseProvider debería poder registrar AIResponseProvider como proveedor activo (prueba de conformidad, no de activación real en la app)');
    run('ResponseProvider.use(LocalResponseProvider);');
    assert(run('ResponseProvider.get() === LocalResponseProvider'), 'ResponseProvider debería volver a aceptar LocalResponseProvider sin problema');
  });

  await check('el mensaje de error de ResponseProvider.use() ante un proveedor incompleto no cambió tras la extracción del contrato', () => {
    const msg = run(`
      (function () {
        try { ResponseProvider.use({}); return null; }
        catch (e) { return e.message; }
      })()
    `);
    assert(/no implementa "explainProduct\(context\)"/.test(msg), `el texto del error cambió inesperadamente: "${msg}"`);
  });

  await check('no existen regresiones: LocalResponseProvider sigue activo y funcionando exactamente igual tras el refactor', async () => {
    const ok = await run(`
      (async function () {
        ResponseProvider.use(LocalResponseProvider);
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const explain = await ResponseProvider.get().explainProduct(ctx);
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const compare = await ResponseProvider.get().compareProducts(ctxA, ctxB);
        const bestAlt = await ResponseProvider.get().bestAlternative(ContextBuilder.build(17, { maxPerType: 300 }));
        const cross = await ResponseProvider.get().crossSell(ContextBuilder.build(52, { maxPerType: 300 }));
        const price = await ResponseProvider.get().priceAndAvailability(ctx);
        return explain.skill === 'explain-product'
          && compare.skill === 'compare-products'
          && bestAlt.skill === 'best-alternative'
          && cross.skill === 'cross-sell'
          && price.skill === 'price-availability';
      })()
    `);
    assert(ok, 'alguna de las 5 habilidades de LocalResponseProvider dejó de responder con la forma esperada');
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
    console.log('ALL AI PROVIDER ABSTRACTION CHECKS PASSED');
  }
}

main();
