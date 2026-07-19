/*
 * Smoke test headless para la habilidad "Venta cruzada inteligente"
 * (response-provider.js + providers/local-response-provider.js).
 *
 * Carga data.js + context-builder.js + response-provider.js +
 * local-response-provider.js en un sandbox de Node (sin DOM, sin red) y
 * verifica el contrato de crossSell() de punta a punta: Context Builder
 * (un solo contexto) -> LocalResponseProvider.crossSell() -> lista
 * ordenada de recomendaciones.
 *
 * Uso: node scripts/verify-cross-sell.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  data: path.join(ROOT, 'assets', 'js', 'data.js'),
  contextBuilder: path.join(ROOT, 'assets', 'js', 'context-builder.js'),
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
    for (const key of ['responseProvider', 'localProvider']) {
      const src = stripComments(fs.readFileSync(FILES[key], 'utf8'));
      const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
      if (hits.length) offenders.push(`${key}: ${hits.join(', ')}`);
    }
    assert(offenders.length === 0, `referencias prohibidas encontradas — ${offenders.join(' | ')}`);
  });

  const sandbox = {};
  vm.createContext(sandbox);
  for (const key of ['data', 'contextBuilder', 'responseProvider', 'localProvider']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('ResponseProvider ahora exige crossSell además de las tres habilidades previas', () => {
    const rejects = run(`
      (function () {
        try {
          ResponseProvider.use({ explainProduct: () => {}, compareProducts: () => {}, bestAlternative: () => {} });
          return false;
        } catch (e) { return /crossSell/.test(e.message); }
      })()
    `);
    assert(rejects, 'un proveedor sin crossSell debería ser rechazado por ResponseProvider.use()');
    run('ResponseProvider.use(LocalResponseProvider);');
    assert(run('ResponseProvider.isReady() === true'), 'LocalResponseProvider debería quedar activo tras use()');
  });

  await check('producto SIN relaciones elegibles para venta cruzada: lista vacía con mensaje honesto', async () => {
    const info = await run(`
      (async function () {
        const ctx = ContextBuilder.build(24, { maxPerType: 300 });
        const elegibles = ctx.relaciones.detalle.filter(d =>
          ['COMPLEMENTA', 'MISMO_BENEFICIO', 'MISMA_AUDIENCIA', 'MISMO_INGREDIENTE'].includes(d.tipo) && d.confianza !== 'Baja'
        );
        const res = await ResponseProvider.get().crossSell(ctx);
        return JSON.stringify({ tieneElegibles: elegibles.length > 0, gradoTotal: ctx.relaciones.total, res });
      })()
    `);
    const { tieneElegibles, gradoTotal, res } = JSON.parse(info);
    assert(!tieneElegibles, 'el producto de prueba (índice 24) ya no cumple la premisa (sin relaciones elegibles) — actualizar el índice');
    assert(gradoTotal > 0, 'el producto de prueba debería seguir teniendo relaciones de OTRO tipo (no es un nodo aislado)');
    assert(Array.isArray(res.recomendaciones) && res.recomendaciones.length === 0, 'recomendaciones debería ser un arreglo vacío');
    assert(typeof res.mensaje === 'string' && res.mensaje.length > 0, 'debería incluir un mensaje honesto explicando que no hay candidatos');
  });

  await check('producto con relaciones elegibles: devuelve recomendaciones reales, ordenadas por relevancia', async () => {
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const res = await ResponseProvider.get().crossSell(ctx);
        if (!res.recomendaciones.length) return false;
        // orden descendente verificable indirectamente: recalcular el score de cada recomendado
        const TYPE_W = { COMPLEMENTA: 3.0, MISMO_BENEFICIO: 2.0, MISMA_AUDIENCIA: 1.5, MISMO_INGREDIENTE: 1.0 };
        const CONF_W = { Alta: 1.0, Media: 0.6 };
        const scores = ctx.relaciones.detalle
          .filter(d => TYPE_W[d.tipo] !== undefined && CONF_W[d.confianza] !== undefined)
          .reduce((acc, d) => {
            acc[d.sku] = (acc[d.sku] || 0) + TYPE_W[d.tipo] * CONF_W[d.confianza];
            return acc;
          }, {});
        const recomendadosScores = res.recomendaciones.map(r => scores[r.sku]);
        const ordenado = recomendadosScores.every((s, i) => i === 0 || recomendadosScores[i - 1] >= s);
        const todosConSku = res.recomendaciones.every(r => typeof r.sku === 'string' && r.sku.length > 0);
        const todosConRazon = res.recomendaciones.every(r => typeof r.razon === 'string' && r.razon.length > 0);
        return ordenado && todosConSku && todosConRazon && res.recomendaciones.length <= 5;
      })()
    `);
    assert(ok, 'las recomendaciones deberían estar ordenadas por score descendente, con sku y razón, y acotadas a 5');
  });

  await check('nunca recomienda basándose en una relación de confianza Baja', async () => {
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const res = await ResponseProvider.get().crossSell(ctx);
        return res.recomendaciones.every(r => !r.razon.includes('confianza Baja'));
      })()
    `);
    assert(ok, 'ninguna razón debería citar una relación de confianza Baja (política R-PIG-04)');
  });

  await check('un candidato con varias relaciones elegibles distintas queda reflejado en la razón ("También comparte")', async () => {
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const res = await ResponseProvider.get().crossSell(ctx);
        return res.recomendaciones.some(r => r.razon.includes('También comparte'));
      })()
    `);
    assert(ok, 'se esperaba que al menos un candidato del producto de prueba (índice 52, con 3 tipos elegibles) combine varias señales en su razón');
  });

  await check('la razón cita el tipo de relación y el texto real de justificación (no inventado)', async () => {
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const res = await ResponseProvider.get().crossSell(ctx);
        const top = res.recomendaciones[0];
        // el candidato puede tener varias relaciones elegibles con este producto
        // (p. ej. COMPLEMENTA y MISMO_BENEFICIO a la vez); la razón cita la de
        // mayor peso, no necesariamente la primera en aparecer en detalle.
        const relacionesReales = ctx.relaciones.detalle.filter(d => d.sku === top.sku);
        return relacionesReales.length > 0 && relacionesReales.some(r => top.razon.includes(r.justificacion));
      })()
    `);
    assert(ok, 'la razón del primer recomendado debería incluir el texto real de al menos una de sus relaciones');
  });

  await check('contexto inválido se rechaza (Promise.reject), no lanza de forma síncrona', async () => {
    const rejected = await run(`
      (async function () {
        try { await LocalResponseProvider.crossSell(null); return false; }
        catch (e) { return true; }
      })()
    `);
    assert(rejected, 'crossSell(null) debería rechazar la Promise');
  });

  await check('no existen regresiones sobre explainProduct, compareProducts ni bestAlternative tras extender el contrato', async () => {
    const ok = await run(`
      (async function () {
        const ctx0 = ContextBuilder.build(0, { maxPerType: 15 });
        const explain = await ResponseProvider.get().explainProduct(ctx0);
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const compare = await ResponseProvider.get().compareProducts(ctxA, ctxB);
        const ctx17 = ContextBuilder.build(17, { maxPerType: 300 });
        const bestAlt = await ResponseProvider.get().bestAlternative(ctx17);
        return explain.skill === 'explain-product' && explain.text.length > 0
          && compare.skill === 'compare-products'
          && bestAlt.skill === 'best-alternative' && bestAlt.encontrado === true;
      })()
    `);
    assert(ok, 'alguna de las tres habilidades previas dejó de funcionar tras agregar crossSell al contrato');
  });

  await check('recorre TODO el catálogo sin lanzar (robustez)', async () => {
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { maxPerType: 300 });
            const res = await ResponseProvider.get().crossSell(ctx);
            if (!Array.isArray(res.recomendaciones)) fallos.push({ i, motivo: 'recomendaciones no es array' });
            if (res.recomendaciones.length > 5) fallos.push({ i, motivo: 'más de 5 recomendaciones' });
            if (res.recomendaciones.length === 0 && !res.mensaje) fallos.push({ i, motivo: 'lista vacía sin mensaje' });
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
    console.log('ALL CROSS SELL CHECKS PASSED');
  }
}

main();
