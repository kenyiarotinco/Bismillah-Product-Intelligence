/*
 * Smoke test headless para la habilidad "Mejor alternativa"
 * (response-provider.js + providers/local-response-provider.js).
 *
 * Carga data.js + context-builder.js + response-provider.js +
 * local-response-provider.js en un sandbox de Node (sin DOM, sin red) y
 * verifica el contrato de bestAlternative() de punta a punta: Context
 * Builder (un solo contexto) -> LocalResponseProvider.bestAlternative() ->
 * respuesta estructurada.
 *
 * Uso: node scripts/verify-best-alternative.js
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

  await check('ResponseProvider ahora exige bestAlternative además de explainProduct/compareProducts', () => {
    const rejects = run(`
      (function () {
        try { ResponseProvider.use({ explainProduct: () => {}, compareProducts: () => {} }); return false; }
        catch (e) { return /bestAlternative/.test(e.message); }
      })()
    `);
    assert(rejects, 'un proveedor sin bestAlternative debería ser rechazado por ResponseProvider.use()');
    run('ResponseProvider.use(LocalResponseProvider);');
    assert(run('ResponseProvider.isReady() === true'), 'LocalResponseProvider debería quedar activo tras use()');
  });

  await check('producto SIN relaciones SUSTITUYE: encontrado=false, con mensaje honesto', async () => {
    const info = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 300 });
        const tieneSustituye = ctx.relaciones.detalle.some(d => d.tipo === 'SUSTITUYE');
        const res = await ResponseProvider.get().bestAlternative(ctx);
        return JSON.stringify({ tieneSustituye, res });
      })()
    `);
    const { tieneSustituye, res } = JSON.parse(info);
    assert(!tieneSustituye, 'el producto de prueba (índice 0) ya no cumple la premisa: ahora tiene SUSTITUYE — actualizar el índice de prueba');
    assert(res.encontrado === false, 'sin relaciones SUSTITUYE, encontrado debería ser false');
    assert(res.alternativa === null && res.afinidad === null, 'alternativa/afinidad deberían ser null cuando no se encontró nada');
    assert(typeof res.mensaje === 'string' && res.mensaje.length > 0, 'debería incluir un mensaje honesto explicando que no se encontró sustituto');
  });

  await check('producto con SUSTITUYE únicamente de confianza Baja: se excluye (política R-PIG-04), encontrado=false', async () => {
    const info = await run(`
      (async function () {
        const ctx = ContextBuilder.build(296, { maxPerType: 300 });
        const soloBaja = ctx.relaciones.detalle
          .filter(d => d.tipo === 'SUSTITUYE')
          .every(d => d.confianza === 'Baja');
        const hayAlgunSustituye = ctx.relaciones.detalle.some(d => d.tipo === 'SUSTITUYE');
        const res = await ResponseProvider.get().bestAlternative(ctx);
        return JSON.stringify({ soloBaja, hayAlgunSustituye, res });
      })()
    `);
    const { soloBaja, hayAlgunSustituye, res } = JSON.parse(info);
    assert(hayAlgunSustituye && soloBaja, 'el producto de prueba (índice 296) ya no cumple la premisa (solo Baja) — actualizar el índice de prueba');
    assert(res.encontrado === false, 'con solo sustitutos de confianza Baja, no debería recomendarse ninguno (R-PIG-04)');
  });

  await check('producto con un SUSTITUYE de confianza Alta: lo recomienda con afinidad Alta', async () => {
    const info = await run(`
      (async function () {
        const ctx = ContextBuilder.build(17, { maxPerType: 300 });
        const altaEsperada = ctx.relaciones.detalle.find(d => d.tipo === 'SUSTITUYE' && d.confianza === 'Alta');
        const res = await ResponseProvider.get().bestAlternative(ctx);
        return JSON.stringify({ altaEsperada, res });
      })()
    `);
    const { altaEsperada, res } = JSON.parse(info);
    assert(altaEsperada, 'el producto de prueba (índice 17) ya no tiene un sustituto de confianza Alta — actualizar el índice de prueba');
    assert(res.encontrado === true, 'debería encontrar una alternativa');
    assert(res.afinidad === 'Alta', `se esperaba afinidad Alta, se obtuvo ${res.afinidad}`);
    assert(res.alternativa.sku === altaEsperada.sku, 'el sku recomendado no coincide con la relación SUSTITUYE de confianza Alta real');
    assert(res.justificacion.includes(altaEsperada.justificacion), 'la justificación debería incluir el texto real de la relación SUSTITUYE');
  });

  await check('producto con SUSTITUYE de confianza Media (sin Alta disponible): lo recomienda con afinidad Media', async () => {
    const info = await run(`
      (async function () {
        const ctx = ContextBuilder.build(62, { maxPerType: 300 });
        const hayAlta = ctx.relaciones.detalle.some(d => d.tipo === 'SUSTITUYE' && d.confianza === 'Alta');
        const res = await ResponseProvider.get().bestAlternative(ctx);
        return JSON.stringify({ hayAlta, res });
      })()
    `);
    const { hayAlta, res } = JSON.parse(info);
    assert(!hayAlta, 'el producto de prueba (índice 62) ya tiene un sustituto Alta — actualizar el índice de prueba');
    assert(res.encontrado === true && res.afinidad === 'Media', `se esperaba encontrado=true con afinidad Media, se obtuvo ${JSON.stringify(res)}`);
  });

  await check('la justificación está grounded en beneficios/categoría/etiquetas reales del producto (no inventados)', async () => {
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(17, { maxPerType: 300 });
        const res = await ResponseProvider.get().bestAlternative(ctx);
        const j = res.justificacion;
        let ok = true;
        if (ctx.producto.subcategoria) ok = ok && j.includes(ctx.producto.subcategoria);
        if (ctx.producto.tags.length) ok = ok && ctx.producto.tags.every(t => j.includes(t));
        return ok;
      })()
    `);
    assert(ok, 'la justificación debería mencionar la subcategoría y las etiquetas reales del producto cuando existen');
  });

  await check('contexto inválido se rechaza (Promise.reject), no lanza de forma síncrona', async () => {
    const rejected = await run(`
      (async function () {
        try { await LocalResponseProvider.bestAlternative(null); return false; }
        catch (e) { return true; }
      })()
    `);
    assert(rejected, 'bestAlternative(null) debería rechazar la Promise');
  });

  await check('no existen regresiones sobre explainProduct ni compareProducts tras extender el contrato', async () => {
    const ok = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 15 });
        const explain = await ResponseProvider.get().explainProduct(ctxA);
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const compare = await ResponseProvider.get().compareProducts(
          ContextBuilder.build(0, { maxPerType: 300 }), ctxB
        );
        return explain.skill === 'explain-product' && typeof explain.text === 'string' && explain.text.length > 0
          && compare.skill === 'compare-products' && Array.isArray(compare.similitudes) && Array.isArray(compare.diferencias);
      })()
    `);
    assert(ok, 'explainProduct o compareProducts dejaron de funcionar tras agregar bestAlternative al contrato');
  });

  await check('nunca recomienda un sustituto de confianza Baja en TODO el catálogo (robustez + política R-PIG-04)', async () => {
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { maxPerType: 300 });
            const res = await ResponseProvider.get().bestAlternative(ctx);
            if (res.encontrado && res.afinidad === 'Baja') fallos.push({ i, motivo: 'afinidad Baja recomendada' });
            if (res.encontrado && (!res.alternativa || !res.alternativa.sku)) fallos.push({ i, motivo: 'alternativa sin sku' });
            if (!res.encontrado && (res.alternativa !== null || res.afinidad !== null)) fallos.push({ i, motivo: 'no encontrado pero alternativa/afinidad no son null' });
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
    console.log('ALL BEST ALTERNATIVE CHECKS PASSED');
  }
}

main();
