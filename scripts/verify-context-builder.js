/*
 * Smoke test headless para assets/js/context-builder.js.
 *
 * Carga data.js + context-builder.js en un sandbox de Node (sin DOM, sin red)
 * y verifica el contrato del módulo contra el dataset real del perfil activo.
 * No sustituye una suite de pruebas formal; es la misma clase de verificación
 * headless usada durante el build del MVP (ver docs/QUALITY_REPORT.md).
 *
 * Uso: node scripts/verify-context-builder.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'assets', 'js', 'data.js');
const CB_PATH = path.join(__dirname, '..', 'assets', 'js', 'context-builder.js');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---- guardrail estático: el módulo no debe tocar red, DOM ni SDKs de IA ----
const source = fs.readFileSync(CB_PATH, 'utf8');
check('no referencia APIs de red/DOM/IA', () => {
  const banned = ['fetch(', 'XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
  const hits = banned.filter(b => source.toLowerCase().includes(b.toLowerCase()));
  assert(hits.length === 0, `referencias prohibidas encontradas: ${hits.join(', ')}`);
});

// ---- carga en sandbox aislado (mismo realm para data.js y context-builder.js) ----
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(DATA_PATH, 'utf8'), sandbox, { filename: 'data.js' });
vm.runInContext(source, sandbox, { filename: 'context-builder.js' });

function run(code) {
  return vm.runInContext(code, sandbox, { filename: 'assert.js' });
}

check('el módulo se carga y expone build()', () => {
  assert(run("typeof ContextBuilder !== 'undefined'"), 'ContextBuilder no está definido');
  assert(run("typeof ContextBuilder.build === 'function'"), 'ContextBuilder.build no es función');
  assert(run("typeof ContextBuilder.SCHEMA_VERSION === 'string'"), 'falta SCHEMA_VERSION');
});

check('build(0) devuelve un contexto con la forma esperada', () => {
  run('globalThis.__ctx0 = ContextBuilder.build(0);');
  const ctx = run('__ctx0');
  assert(ctx, 'build(0) devolvió null/undefined');
  for (const key of ['meta', 'producto', 'relaciones', 'comercial']) {
    assert(key in ctx, `falta la clave "${key}"`);
  }
  assert(ctx.producto.sku === String(run('DATA.products[0][0]')), 'sku no coincide con DATA');
  assert(Array.isArray(ctx.relaciones.detalle), 'relaciones.detalle no es array');
  assert(Array.isArray(ctx.relaciones.porTipo), 'relaciones.porTipo no es array');
  return `sku=${ctx.producto.sku} total=${ctx.relaciones.total}`;
});

check('el contexto es JSON-serializable (round-trip exacto)', () => {
  const ok = run('JSON.stringify(JSON.parse(JSON.stringify(__ctx0))) === JSON.stringify(__ctx0)');
  assert(ok, 'el objeto no sobrevive un round-trip JSON.stringify/parse');
});

check('build por índice y build por SKU son equivalentes', () => {
  const equal = run(`
    (function () {
      const bySku = ContextBuilder.build(__ctx0.producto.sku);
      const left = JSON.stringify({ ...bySku, meta: { ...bySku.meta, generadoEn: null } });
      const right = JSON.stringify({ ...__ctx0, meta: { ...__ctx0.meta, generadoEn: null } });
      return left === right;
    })()
  `);
  assert(equal, 'build(index) y build(sku) difieren en algo más que el timestamp');
});

check('bloque comercial nunca contiene datos inventados', () => {
  const c = run('__ctx0.comercial');
  assert(c.disponible === false, 'comercial.disponible debería ser false hoy');
  for (const k of ['precio', 'stock', 'margen', 'estado']) {
    assert(c[k] === null, `comercial.${k} debería ser null, no ${JSON.stringify(c[k])}`);
  }
  assert(typeof c.pendienteDe === 'string' && c.pendienteDe.length > 0, 'falta comercial.pendienteDe');
});

check('producto sin subcategoría (NO_CLASIFICADO) no rompe el builder', () => {
  const idx = run("DATA.products.findIndex(p => p[2] < 0)");
  if (idx < 0) return 'no hay productos NO_CLASIFICADO en este dataset — omitido';
  const ctx = run(`ContextBuilder.build(${idx})`);
  assert(ctx.producto.subcategoria === null, 'subcategoria debería ser null');
  assert(ctx.producto.familiaCodigo === null, 'familiaCodigo debería ser null');
  assert(ctx.producto.universo === null, 'universo debería ser null');
  return `verificado con índice ${idx}`;
});

check('producto hub: porTipo cuadra con el total y detalle respeta el tope por tipo', () => {
  const parsed = JSON.parse(run(`
    (function () {
      let best = 0;
      for (let i = 1; i < DATA.products.length; i++) if (DATA.products[i][3] > DATA.products[best][3]) best = i;
      const ctx = ContextBuilder.build(best, { maxPerType: 5 });
      const sumaPorTipo = ctx.relaciones.porTipo.reduce((s, r) => s + r.cantidad, 0);
      const conteoDetallePorTipo = {};
      for (const d of ctx.relaciones.detalle) conteoDetallePorTipo[d.tipo] = (conteoDetallePorTipo[d.tipo] || 0) + 1;
      const excede = Object.values(conteoDetallePorTipo).some(n => n > 5);
      return JSON.stringify({ idx: best, total: ctx.relaciones.total, sumaPorTipo, excede, detalleLen: ctx.relaciones.detalle.length });
    })()
  `));
  assert(parsed.total === parsed.sumaPorTipo, `total (${parsed.total}) !== suma de porTipo (${parsed.sumaPorTipo})`);
  assert(parsed.excede === false, 'algún tipo superó el tope maxPerType en detalle');
  return JSON.stringify(parsed);
});

check('referencia inválida devuelve null en vez de lanzar', () => {
  assert(run('ContextBuilder.build(999999) === null'), 'índice fuera de rango debería devolver null');
  assert(run("ContextBuilder.build('SKU-QUE-NO-EXISTE') === null"), 'SKU inexistente debería devolver null');
});

check('llamadas repetidas son puras (no acumulan estado)', () => {
  const same = run(`
    (function () {
      const first = ContextBuilder.build(0);
      const second = ContextBuilder.build(0);
      const norm = x => JSON.stringify({ ...x, meta: { ...x.meta, generadoEn: null } });
      return norm(first) === norm(second);
    })()
  `);
  assert(same, 'dos llamadas consecutivas con el mismo producto difieren');
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
  console.log('ALL CONTEXT BUILDER CHECKS PASSED');
}
