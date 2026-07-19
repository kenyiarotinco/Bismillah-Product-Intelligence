/*
 * Smoke test headless para response-provider.js + providers/local-response-provider.js.
 *
 * Carga data.js + context-builder.js + response-provider.js +
 * local-response-provider.js en un sandbox de Node (sin DOM, sin red) y
 * verifica el contrato de la habilidad "Explicar producto" de punta a punta:
 * Context Builder → Local Response Provider → texto final.
 *
 * Uso: node scripts/verify-response-provider.js
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
  // ---- guardrail estático: ningún archivo de este paso debe tocar red/DOM/IA ----
  // Se evalúa sobre el CÓDIGO, no sobre los comentarios: response-provider.js
  // y local-response-provider.js mencionan "Gemini" a propósito en su
  // documentación (justificando cómo se reemplazará el proveedor más
  // adelante) — eso es exactamente lo pedido en este paso, no una
  // integración real. Lo que este guardrail no debe permitir es código
  // ejecutable que llame a red, DOM o un SDK de IA.
  await check('ningún archivo del paso referencia red/DOM/SDKs de IA en código ejecutable', () => {
    const banned = ['fetch(', 'XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = [];
    for (const [label, file] of Object.entries(FILES)) {
      if (label === 'data') continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
      if (hits.length) offenders.push(`${label}: ${hits.join(', ')}`);
    }
    assert(offenders.length === 0, `referencias prohibidas encontradas — ${offenders.join(' | ')}`);
  });

  // ---- carga en sandbox aislado, mismo orden que los <script> en index.html ----
  const sandbox = {};
  vm.createContext(sandbox);
  for (const key of ['data', 'contextBuilder', 'responseProviderContract', 'responseProvider', 'localProvider']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('ResponseProvider exige el contrato antes de aceptar un proveedor', () => {
    const threw = run(`
      (function () {
        try { ResponseProvider.use({}); return false; }
        catch (e) { return /explainProduct/.test(e.message); }
      })()
    `);
    assert(threw, 'ResponseProvider.use no rechazó un proveedor sin explainProduct()');
    assert(run('ResponseProvider.isReady() === false'), 'isReady() debería ser false antes de registrar un proveedor');
  });

  await check('LocalResponseProvider se registra y queda activo', () => {
    run('ResponseProvider.use(LocalResponseProvider);');
    assert(run('ResponseProvider.isReady() === true'), 'isReady() debería ser true tras use()');
    assert(run('ResponseProvider.get() === LocalResponseProvider'), 'get() debería devolver el proveedor registrado');
  });

  await check('explainProduct(context) devuelve la forma esperada (Promise)', async () => {
    const shapeOk = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const res = await ResponseProvider.get().explainProduct(ctx);
        globalThis.__lastRes = res;
        return typeof res.skill === 'string'
          && res.skill === 'explain-product'
          && res.source === 'local'
          && typeof res.generatedAt === 'string'
          && typeof res.text === 'string'
          && res.text.length > 0;
      })()
    `);
    assert(shapeOk, 'la forma de la respuesta no coincide con el contrato');
    return run('__lastRes.text').slice(0, 80) + '…';
  });

  await check('el texto nunca menciona precio/stock/margen inventados', () => {
    const text = run('__lastRes.text');
    assert(/Fase 1/.test(text) || /pendient/i.test(text), 'se esperaba una mención honesta de datos comerciales pendientes');
    const hasFakeNumberClaims = /S\/\s?\d/.test(text); // "S/ 69.90"-style price claims
    assert(!hasFakeNumberClaims, 'el texto contiene lo que parece ser un precio inventado');
  });

  await check('cada beneficio citado en el texto proviene de una justificación real', () => {
    const ok = run(`
      (function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const benefRel = ctx.relaciones.detalle.filter(d => d.tipo === 'MISMO_BENEFICIO');
        const beneficiosReales = new Set();
        for (const d of benefRel) {
          const m = /'([^']+)'/.exec(d.justificacion);
          if (m) beneficiosReales.add(m[1]);
        }
        if (beneficiosReales.size === 0) return true; // nada que verificar para este producto
        const linea = __lastRes.text.split('\\n\\n').find(l => l.startsWith('Beneficios asociados'));
        if (!linea) return false;
        const citados = linea.replace('Beneficios asociados en el catálogo: ', '').replace(/\\.$/, '').split(', ');
        return citados.every(c => beneficiosReales.has(c));
      })()
    `);
    assert(ok, 'algún beneficio citado en el texto no proviene de una justificación real de este producto');
  });

  await check('build por SKU + explainProduct funciona igual que por índice', async () => {
    const equal = await run(`
      (async function () {
        const ctxIdx = ContextBuilder.build(0, { maxPerType: 15 });
        const ctxSku = ContextBuilder.build(ctxIdx.producto.sku, { maxPerType: 15 });
        const [a, b] = await Promise.all([
          ResponseProvider.get().explainProduct(ctxIdx),
          ResponseProvider.get().explainProduct(ctxSku),
        ]);
        return a.text === b.text;
      })()
    `);
    assert(equal, 'el texto generado difiere entre build(índice) y build(sku) del mismo producto');
  });

  await check('contexto inválido se rechaza (Promise.reject), no lanza de forma síncrona', async () => {
    const rejected = await run(`
      (async function () {
        try { await LocalResponseProvider.explainProduct(null); return false; }
        catch (e) { return true; }
      })()
    `);
    assert(rejected, 'explainProduct(null) debería rechazar la Promise, no devolver algo utilizable');
  });

  await check('recorre TODOS los productos del dataset sin lanzar (robustez del texto)', async () => {
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { maxPerType: 15 });
            const res = await ResponseProvider.get().explainProduct(ctx);
            if (typeof res.text !== 'string' || !res.text.length) fallos.push(i);
          } catch (e) { fallos.push(i); }
        }
        return fallos;
      })()
    `);
    assert(Array.isArray(bad) && bad.length === 0, `${bad.length} producto(s) fallaron: ${bad.slice(0, 10).join(', ')}`);
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
    console.log('ALL RESPONSE PROVIDER CHECKS PASSED');
  }
}

main();
