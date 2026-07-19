/*
 * Smoke test headless para la integración de datos comerciales
 * (assets/js/commercial-data-provider.js + la extensión aditiva del bloque
 * `comercial` en assets/js/context-builder.js — Fase 3, Paso 1).
 *
 * Carga data.js + context-builder.js + commercial-data-provider.js en un
 * sandbox de Node (sin DOM, sin red) y verifica, sobre todo, que la
 * integración es genuinamente ADITIVA: sin proveedor cargado o sin dato
 * para un SKU, el resultado es exactamente el mismo `comercial` en null que
 * ya existía desde el Paso 2.
 *
 * Uso: node scripts/verify-commercial-data.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  data: path.join(ROOT, 'assets', 'js', 'data.js'),
  contextBuilder: path.join(ROOT, 'assets', 'js', 'context-builder.js'),
  commercialProvider: path.join(ROOT, 'assets', 'js', 'commercial-data-provider.js'),
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
  await check('context-builder.js y commercial-data-provider.js no referencian red/DOM/SDKs de IA en código ejecutable', () => {
    const banned = ['fetch(', 'XMLHttpRequest', 'document.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = [];
    for (const key of ['contextBuilder', 'commercialProvider']) {
      const src = stripComments(fs.readFileSync(FILES[key], 'utf8'));
      const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
      if (hits.length) offenders.push(`${key}: ${hits.join(', ')}`);
    }
    assert(offenders.length === 0, `referencias prohibidas encontradas — ${offenders.join(' | ')}`);
  });

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILES.data, 'utf8'), sandbox, { filename: 'data.js' });
  vm.runInContext(fs.readFileSync(FILES.contextBuilder, 'utf8'), sandbox, { filename: 'context-builder.js' });
  vm.runInContext(fs.readFileSync(FILES.commercialProvider, 'utf8'), sandbox, { filename: 'commercial-data-provider.js' });
  const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });

  await check('CommercialDataProvider.getBySku() devuelve null si window.COMMERCIAL_DATA no está cargado', () => {
    const ok = run(`
      typeof COMMERCIAL_DATA === 'undefined'
        && CommercialDataProvider.getBySku('20068') === null
        && CommercialDataProvider.isAvailable() === false
    `);
    assert(ok, 'sin COMMERCIAL_DATA cargado, getBySku() debería devolver null e isAvailable() debería ser false');
  });

  await check('ContextBuilder.build() sin proveedor comercial: comercial idéntico al de antes de este paso (Paso 2)', () => {
    const shape = JSON.parse(run("JSON.stringify(ContextBuilder.build(0).comercial)"));
    assert(shape.disponible === false, 'disponible debería seguir siendo false');
    assert(shape.precio === null && shape.stock === null && shape.margen === null && shape.estado === null, 'todos los campos originales deberían seguir en null');
    assert(shape.priceDifference === null, 'el nuevo campo priceDifference también debería ser null cuando no hay dato');
    assert(shape.pendienteDe === 'Fase 1 — Integración de Datos', 'pendienteDe debería mantener exactamente el texto original');
    assert(Object.keys(shape).sort().join(',') === 'disponible,estado,margen,pendienteDe,precio,priceDifference,stock', 'el shape debería ser exactamente el original + priceDifference, sin más cambios');
  });

  await check('inyectando un commercialProvider de prueba CON registro: comercial se completa correctamente', () => {
    const info = JSON.parse(run(`
      (function () {
        const fakeProvider = { getBySku: sku => sku === '45471' ? { precio: 99.9, stock: 12, estado: 'Stock medio', priceDifference: 3.5 } : null };
        const ctx = ContextBuilder.build('45471', { commercialProvider: fakeProvider });
        return JSON.stringify(ctx.comercial);
      })()
    `));
    assert(info.disponible === true, 'disponible debería ser true cuando el proveedor tiene el SKU');
    assert(info.precio === 99.9 && info.stock === 12 && info.estado === 'Stock medio', 'precio/stock/estado deberían venir del registro del proveedor');
    assert(info.priceDifference === 3.5, 'priceDifference debería venir del registro del proveedor');
    assert(info.margen === null, 'margen NUNCA debería poblarse a partir de priceDifference — sigue sin haber dato real de margen de utilidad');
    assert(info.pendienteDe === null, 'pendienteDe debería quedar null cuando sí hay dato disponible');
  });

  await check('inyectando un commercialProvider disponible pero SIN registro para ese SKU: mismo comportamiento que sin proveedor', () => {
    const info = JSON.parse(run(`
      (function () {
        const fakeProvider = { getBySku: () => null };
        const ctx = ContextBuilder.build(0, { commercialProvider: fakeProvider });
        return JSON.stringify(ctx.comercial);
      })()
    `));
    assert(info.disponible === false, 'un SKU sin cobertura comercial debería comportarse igual que si no hubiera proveedor');
    assert(info.pendienteDe === 'Fase 1 — Integración de Datos', 'pendienteDe debería mantener el texto original para SKUs sin cobertura');
  });

  await check('el resto del contexto (producto, relaciones, meta) no cambia por la presencia del proveedor comercial', () => {
    const igual = run(`
      (function () {
        const sinProveedor = ContextBuilder.build(17, { commercialProvider: { getBySku: () => null } });
        const conProveedor = ContextBuilder.build(17, { commercialProvider: { getBySku: () => ({ precio: 1, stock: 1, estado: 'x', priceDifference: 0 }) } });
        const a = JSON.stringify({ ...sinProveedor, comercial: null, meta: null });
        const b = JSON.stringify({ ...conProveedor, comercial: null, meta: null });
        return a === b;
      })()
    `);
    assert(igual, 'producto/relaciones no deberían verse afectados por el bloque comercial en absoluto');
  });

  await check('recorre TODO el catálogo con y sin proveedor comercial simulado, sin lanzar (robustez)', () => {
    const n = run('DATA.products.length');
    const bad = run(`
      (function () {
        const fallos = [];
        const proveedorParcial = { getBySku: sku => (Number(sku) % 7 === 0) ? { precio: 1, stock: 1, estado: 'Stock bajo', priceDifference: 0 } : null };
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const sinProv = ContextBuilder.build(i);
            const conProv = ContextBuilder.build(i, { commercialProvider: proveedorParcial });
            if (sinProv.comercial.disponible !== false) fallos.push({ i, motivo: 'disponible debería ser false sin proveedor global' });
            if (typeof conProv.comercial.disponible !== 'boolean') fallos.push({ i, motivo: 'disponible no es boolean' });
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
    console.log('ALL COMMERCIAL DATA CHECKS PASSED');
  }
}

main();
