/*
 * Smoke test headless para la habilidad "Comparar productos"
 * (response-provider.js + providers/local-response-provider.js).
 *
 * Carga data.js + context-builder.js + response-provider.js +
 * local-response-provider.js en un sandbox de Node (sin DOM, sin red) y
 * verifica el contrato de compareProducts() de punta a punta: dos Context
 * Builder independientes → LocalResponseProvider.compareProducts() →
 * respuesta estructurada.
 *
 * Uso: node scripts/verify-compare-products.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  data: path.join(ROOT, 'assets', 'js', 'data.js'),
  contextBuilder: path.join(ROOT, 'assets', 'js', 'context-builder.js'),
  responseProviderContract: path.join(ROOT, 'assets', 'js', 'response-provider-contract.js'),
  responseProvider: path.join(ROOT, 'assets', 'js', 'response-provider.js'),
  localProvider: path.join(ROOT, 'assets', 'js', 'providers', 'local-response-provider.js'),
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
  await check('response-provider.js y local-response-provider.js no referencian red/DOM/SDKs de IA en código ejecutable', () => {
    const banned = ['fetch(', 'XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = [];
    for (const key of ['responseProviderContract', 'responseProvider', 'localProvider']) {
      const src = stripComments(fs.readFileSync(FILES[key], 'utf8'));
      const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
      if (hits.length) offenders.push(`${key}: ${hits.join(', ')}`);
    }
    assert(offenders.length === 0, `referencias prohibidas encontradas — ${offenders.join(' | ')}`);
  });

  const sandbox = {};
  vm.createContext(sandbox);
  for (const key of ['data', 'contextBuilder', 'responseProviderContract', 'responseProvider', 'localProvider']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('ResponseProvider ahora exige compareProducts además de explainProduct', () => {
    const rejects = run(`
      (function () {
        try { ResponseProvider.use({ explainProduct: () => {} }); return false; }
        catch (e) { return /compareProducts/.test(e.message); }
      })()
    `);
    assert(rejects, 'un proveedor sin compareProducts debería ser rechazado por ResponseProvider.use()');
    run('ResponseProvider.use(LocalResponseProvider);');
    assert(run('ResponseProvider.isReady() === true'), 'LocalResponseProvider debería quedar activo tras use()');
  });

  await check('compareProducts(contextA, contextB) devuelve la forma esperada', async () => {
    const ok = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const res = await ResponseProvider.get().compareProducts(ctxA, ctxB);
        globalThis.__lastCompare = res;
        return res.skill === 'compare-products'
          && res.source === 'local'
          && typeof res.generatedAt === 'string'
          && Array.isArray(res.similitudes)
          && Array.isArray(res.diferencias)
          && res.productos && res.productos.a && res.productos.b
          && res.productos.a.sku === ctxA.producto.sku
          && res.productos.b.sku === ctxB.producto.sku;
      })()
    `);
    assert(ok, 'la forma de la respuesta no coincide con el contrato, o los SKUs de A/B no corresponden a los contextos originales');
  });

  await check('usa dos Context Builder independientes (A y B no se mezclan)', () => {
    const distinct = run(`
      (function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        return ctxA.producto.sku !== ctxB.producto.sku
          && ctxA.meta.productoIndice === 0
          && ctxB.meta.productoIndice === 1;
      })()
    `);
    assert(distinct, 'los contextos A y B deberían ser dos objetos independientes con índices distintos');
  });

  await check('reporta similitudes cuando dos productos comparten subcategoría', async () => {
    const info = JSON.parse(run(`
      (function () {
        // busca un par de productos con la misma subcategoría para forzar una similitud real
        for (let i = 0; i < DATA.products.length; i++) {
          for (let j = i + 1; j < DATA.products.length; j++) {
            if (DATA.products[i][2] >= 0 && DATA.products[i][2] === DATA.products[j][2]) {
              return JSON.stringify({ i, j });
            }
          }
          if (i > 40) break; // suficiente muestra, evitar recorrer todo el catálogo
        }
        return JSON.stringify(null);
      })()
    `));
    assert(info, 'no se encontró un par de productos con la misma subcategoría en la muestra inicial');
    const hasCategorySimilarity = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(${info.i}, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(${info.j}, { maxPerType: 300 });
        const res = await ResponseProvider.get().compareProducts(ctxA, ctxB);
        return res.similitudes.some(s => s.includes('misma subcategoría'));
      })()
    `);
    assert(hasCategorySimilarity, 'dos productos de la misma subcategoría deberían reportar esa similitud explícitamente');
  });

  await check('reporta diferencias cuando dos productos NO comparten subcategoría', async () => {
    const diff = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        let idxB = -1;
        for (let j = 1; j < DATA.products.length; j++) {
          if (DATA.products[j][2] !== DATA.products[0][2]) { idxB = j; break; }
        }
        const ctxB = ContextBuilder.build(idxB, { maxPerType: 300 });
        const res = await ResponseProvider.get().compareProducts(ctxA, ctxB);
        return res.diferencias.length > 0;
      })()
    `);
    assert(diff, 'dos productos de distinta subcategoría deberían reportar al menos una diferencia');
  });

  await check('detecta una relación directa real entre dos productos conectados en el grafo', async () => {
    const ok = await run(`
      (async function () {
        // toma el producto de mayor grado y uno de sus vecinos reales
        let hub = 0;
        for (let i = 1; i < DATA.products.length; i++) if (DATA.products[i][3] > DATA.products[hub][3]) hub = i;
        const ctxHub = ContextBuilder.build(hub, { maxPerType: 300 });
        const vecino = ctxHub.relaciones.detalle[0];
        const idxVecino = DATA.products.findIndex(p => String(p[0]) === vecino.sku);
        const ctxVecino = ContextBuilder.build(idxVecino, { maxPerType: 300 });
        const res = await ResponseProvider.get().compareProducts(ctxHub, ctxVecino);
        return res.similitudes.some(s => s.includes('directamente relacionados'));
      })()
    `);
    assert(ok, 'dos productos con una arista real entre ellos deberían reportar la relación directa como similitud');
  });

  await check('contexto inválido se rechaza (Promise.reject), no lanza de forma síncrona', async () => {
    const rejected = await run(`
      (async function () {
        try { await LocalResponseProvider.compareProducts(null, ContextBuilder.build(0)); return false; }
        catch (e) { return true; }
      })()
    `);
    assert(rejected, 'compareProducts(null, contexto) debería rechazar la Promise');
  });

  await check('no existen regresiones sobre explainProduct tras extender el contrato', async () => {
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const res = await ResponseProvider.get().explainProduct(ctx);
        return res.skill === 'explain-product' && typeof res.text === 'string' && res.text.length > 0;
      })()
    `);
    assert(ok, 'explainProduct dejó de funcionar tras agregar compareProducts al contrato');
  });

  await check('recorre pares consecutivos de TODO el catálogo sin lanzar (robustez)', async () => {
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        for (let i = 0; i < DATA.products.length - 1; i++) {
          try {
            const ctxA = ContextBuilder.build(i, { maxPerType: 300 });
            const ctxB = ContextBuilder.build(i + 1, { maxPerType: 300 });
            const res = await ResponseProvider.get().compareProducts(ctxA, ctxB);
            if (!Array.isArray(res.similitudes) || !Array.isArray(res.diferencias)) fallos.push(i);
          } catch (e) { fallos.push(i); }
        }
        return fallos;
      })()
    `);
    assert(Array.isArray(bad) && bad.length === 0, `${bad.length} par(es) fallaron en índices: ${bad.slice(0, 10).join(', ')}`);
    return `${n - 1} pares consecutivos verificados`;
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
    console.log('ALL COMPARE PRODUCTS CHECKS PASSED');
  }
}

main();
