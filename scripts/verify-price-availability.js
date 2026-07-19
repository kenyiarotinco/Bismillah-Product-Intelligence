/*
 * Smoke test headless para la habilidad "Precio y disponibilidad"
 * (response-provider.js + providers/local-response-provider.js —
 * Fase 3, Paso 2).
 *
 * Carga data.js + context-builder.js + response-provider.js +
 * local-response-provider.js en un sandbox de Node (sin DOM, sin red) y
 * verifica el contrato de priceAndAvailability() de punta a punta,
 * incluyendo los 3 casos de uso de la especificación: producto CON dato
 * comercial, producto SIN dato comercial, y perfil Demo (sin
 * CommercialDataProvider cargado en absoluto).
 *
 * Uso: node scripts/verify-price-availability.js
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

  await check('local-response-provider.js no llama a CommercialDataProvider ni lee COMMERCIAL_DATA (solo lee context.comercial)', () => {
    const src = fs.readFileSync(FILES.localProvider, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = ['CommercialDataProvider', 'COMMERCIAL_DATA'].filter(t => src.includes(t));
    assert(offenders.length === 0, `local-response-provider.js no debería referenciar: ${offenders.join(', ')}`);
  });

  const sandbox = {};
  vm.createContext(sandbox);
  for (const key of ['data', 'contextBuilder', 'responseProviderContract', 'responseProvider', 'localProvider']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('ResponseProvider ahora exige priceAndAvailability además de las cuatro habilidades previas', () => {
    const rejects = run(`
      (function () {
        try {
          ResponseProvider.use({ explainProduct: () => {}, compareProducts: () => {}, bestAlternative: () => {}, crossSell: () => {} });
          return false;
        } catch (e) { return /priceAndAvailability/.test(e.message); }
      })()
    `);
    assert(rejects, 'un proveedor sin priceAndAvailability debería ser rechazado por ResponseProvider.use()');
    run('ResponseProvider.use(LocalResponseProvider);');
    assert(run('ResponseProvider.isReady() === true'), 'LocalResponseProvider debería quedar activo tras use()');
  });

  await check('Caso 1 — producto CON datos comerciales: precio final, precio lista, diferencia, stock y estado', async () => {
    const info = await run(`
      (async function () {
        const fakeProvider = { getBySku: sku => sku === '45471' ? { precio: 50, stock: 12, estado: 'Stock medio', priceDifference: 5 } : null };
        const ctx = ContextBuilder.build('45471', { commercialProvider: fakeProvider });
        const res = await ResponseProvider.get().priceAndAvailability(ctx);
        return JSON.stringify(res);
      })()
    `);
    const res = JSON.parse(info);
    assert(res.skill === 'price-availability' && res.source === 'local' && typeof res.generatedAt === 'string', 'forma base de la respuesta incorrecta');
    assert(res.disponible === true, 'disponible debería ser true');
    assert(res.precio === 50, 'precio (final) debería venir de comercial.precio');
    assert(res.precioLista === 55, `precioLista debería derivarse como precio + priceDifference (55), se obtuvo ${res.precioLista}`);
    assert(res.priceDifference === 5, 'priceDifference debería venir de comercial.priceDifference');
    assert(res.stock === 12, 'stock debería venir de comercial.stock');
    assert(res.estado === 'Stock medio', 'estado debería venir de comercial.estado');
    assert(res.mensaje === null, 'mensaje debería ser null cuando hay datos');
  });

  await check('precioLista REAL tiene prioridad sobre el cálculo derivado cuando ambos están disponibles', async () => {
    const res = JSON.parse(await run(`
      (async function () {
        // precio + priceDifference derivaría 55, pero el proveedor trae un
        // precioLista real distinto (58.9) — debe ganar el real, no el cálculo.
        const fakeProvider = { getBySku: () => ({ precio: 50, precioLista: 58.9, stock: 12, estado: 'Stock medio', priceDifference: 5 }) };
        const ctx = ContextBuilder.build(0, { commercialProvider: fakeProvider });
        const r = await ResponseProvider.get().priceAndAvailability(ctx);
        return JSON.stringify(r);
      })()
    `));
    assert(res.precioLista === 58.9, `debería priorizar el precioLista real (58.9) sobre el derivado (55), se obtuvo ${res.precioLista}`);
  });

  await check('precioLista cae al cálculo derivado (fallback) cuando el dataset NO trae un precioLista real', async () => {
    const res = JSON.parse(await run(`
      (async function () {
        const fakeProvider = { getBySku: () => ({ precio: 50, stock: 12, estado: 'Stock medio', priceDifference: 5 }) };
        const ctx = ContextBuilder.build(0, { commercialProvider: fakeProvider });
        const r = await ResponseProvider.get().priceAndAvailability(ctx);
        return JSON.stringify(r);
      })()
    `));
    assert(res.precioLista === 55, `sin precioLista real, debería usar el cálculo de respaldo (50 + 5 = 55), se obtuvo ${res.precioLista}`);
  });

  await check('Caso 2 — producto SIN datos comerciales: informa que no hay información disponible', async () => {
    const info = await run(`
      (async function () {
        const fakeProvider = { getBySku: () => null };
        const ctx = ContextBuilder.build(0, { commercialProvider: fakeProvider });
        const res = await ResponseProvider.get().priceAndAvailability(ctx);
        return JSON.stringify(res);
      })()
    `);
    const res = JSON.parse(info);
    assert(res.disponible === false, 'disponible debería ser false sin dato comercial');
    assert(res.precio === null && res.precioLista === null && res.priceDifference === null && res.stock === null && res.estado === null, 'todos los campos numéricos/estado deberían ser null');
    assert(typeof res.mensaje === 'string' && res.mensaje.length > 0, 'debería incluir un mensaje honesto');
    // El mensaje puede legítimamente contener dígitos (el nombre real del
    // producto suele incluir tamaños de empaque, p. ej. "X 330 UNID.") — lo
    // que no debe contener es un precio con formato de moneda fabricado.
    assert(!/S\/\s?\d/.test(res.mensaje), 'el mensaje de "no disponible" no debería contener lo que parece un precio inventado');
  });

  await check('Caso 3 — perfil Demo (sin CommercialDataProvider en absoluto): siempre "no disponible", nunca lanza', async () => {
    const ok = await run(`
      (async function () {
        // Ni siquiera se pasa commercialProvider, y CommercialDataProvider
        // no está cargado en este sandbox — exactamente la situación del
        // perfil demo público.
        const ctx = ContextBuilder.build(0);
        const res = await ResponseProvider.get().priceAndAvailability(ctx);
        return res.disponible === false && typeof res.mensaje === 'string';
      })()
    `);
    assert(ok, 'sin CommercialDataProvider cargado, priceAndAvailability debería devolver disponible:false con mensaje, no lanzar');
  });

  await check('precioLista queda en null cuando priceDifference no está disponible (no fuerza un cálculo incompleto)', async () => {
    const res = JSON.parse(await run(`
      (async function () {
        const fakeProvider = { getBySku: () => ({ precio: 20, stock: 3, estado: 'Stock bajo', priceDifference: null }) };
        const ctx = ContextBuilder.build(0, { commercialProvider: fakeProvider });
        const r = await ResponseProvider.get().priceAndAvailability(ctx);
        return JSON.stringify(r);
      })()
    `));
    assert(res.disponible === true, 'debería seguir disponible aunque falte priceDifference');
    assert(res.precioLista === null, 'precioLista debería ser null si no se puede derivar');
    assert(res.precio === 20 && res.stock === 3 && res.estado === 'Stock bajo', 'el resto de campos debería completarse igual');
  });

  await check('contexto inválido se rechaza (Promise.reject), no lanza de forma síncrona', async () => {
    const rejected = await run(`
      (async function () {
        try { await LocalResponseProvider.priceAndAvailability(null); return false; }
        catch (e) { return true; }
      })()
    `);
    assert(rejected, 'priceAndAvailability(null) debería rechazar la Promise');
  });

  await check('no existen regresiones sobre explainProduct, compareProducts, bestAlternative ni crossSell', async () => {
    const ok = await run(`
      (async function () {
        const ctx0 = ContextBuilder.build(0, { maxPerType: 15 });
        const explain = await ResponseProvider.get().explainProduct(ctx0);
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const compare = await ResponseProvider.get().compareProducts(ctxA, ctxB);
        const ctx17 = ContextBuilder.build(17, { maxPerType: 300 });
        const bestAlt = await ResponseProvider.get().bestAlternative(ctx17);
        const ctx52 = ContextBuilder.build(52, { maxPerType: 300 });
        const xsell = await ResponseProvider.get().crossSell(ctx52);
        return explain.skill === 'explain-product' && explain.text.length > 0
          && compare.skill === 'compare-products'
          && bestAlt.skill === 'best-alternative' && bestAlt.encontrado === true
          && xsell.skill === 'cross-sell' && Array.isArray(xsell.recomendaciones);
      })()
    `);
    assert(ok, 'alguna de las cuatro habilidades previas dejó de funcionar tras agregar priceAndAvailability al contrato');
  });

  await check('recorre TODO el catálogo (con y sin cobertura comercial simulada) sin lanzar', async () => {
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        const proveedorParcial = { getBySku: sku => (Number(sku) % 5 === 0) ? { precio: 10, stock: 5, estado: 'Stock bajo', priceDifference: 1 } : null };
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { commercialProvider: proveedorParcial });
            const res = await ResponseProvider.get().priceAndAvailability(ctx);
            if (typeof res.disponible !== 'boolean') fallos.push({ i, motivo: 'disponible no es boolean' });
            if (!res.disponible && res.mensaje === null) fallos.push({ i, motivo: 'no disponible sin mensaje' });
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
    console.log('ALL PRICE & AVAILABILITY CHECKS PASSED');
  }
}

main();
