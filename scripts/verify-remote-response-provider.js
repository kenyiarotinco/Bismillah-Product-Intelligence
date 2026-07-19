/*
 * Smoke test headless para RemoteResponseProvider (Fase 4, Paso 3).
 *
 * Carga data.js + context-builder.js + prompt-context-builder.js +
 * commercial-data-provider.js + feature-flags.js + response-provider-contract.js
 * + response-provider.js + providers/local-response-provider.js +
 * providers/remote-response-provider.js en un sandbox de Node (sin DOM,
 * sin red real — `fetch` se simula por escenario) y verifica: integración
 * del proveedor remoto, fallback automático ante cualquier error, y que con
 * el feature flag desactivado el comportamiento es idéntico al de
 * LocalResponseProvider.
 *
 * Uso: node scripts/verify-remote-response-provider.js
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
};
const LOAD_ORDER = [
  'data', 'contextBuilder', 'promptContextBuilder', 'commercialDataProvider',
  'featureFlags', 'responseProviderContract', 'responseProvider', 'localProvider', 'remoteProvider',
];

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

// Crea un sandbox nuevo, con `fetch` y los globals opcionales que indique el
// escenario (FEATURE_FLAGS / REMOTE_PROVIDER_CONFIG) ya definidos ANTES de
// cargar los módulos — mismo orden que los <script> en index.html.
function freshSandbox({ featureFlags, remoteConfig, fetchImpl } = {}) {
  const sandbox = {};
  vm.createContext(sandbox);
  // Un vm.createContext() vacío NO trae setTimeout/clearTimeout/AbortController
  // — sin inyectarlos, el manejo de timeout de RemoteResponseProvider (Fase 4,
  // Paso 4) queda en silencio como no-op (typeof AbortController === 'undefined'
  // dentro del sandbox) y una Promise que solo se resuelve por un abort() nunca
  // se resuelve — el proceso de Node termina sin imprimir nada en cuanto no
  // queda nada más pendiente en el event loop. Se inyectan aquí, igual que ya
  // se inyecta `fetch`.
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.AbortController = AbortController;
  if (featureFlags !== undefined) vm.runInContext(`var FEATURE_FLAGS = ${JSON.stringify(featureFlags)};`, sandbox);
  if (remoteConfig !== undefined) vm.runInContext(`var REMOTE_PROVIDER_CONFIG = ${JSON.stringify(remoteConfig)};`, sandbox);
  if (fetchImpl) sandbox.fetch = fetchImpl;
  for (const key of LOAD_ORDER) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  return sandbox;
}

// Compara dos respuestas de habilidad ignorando `generatedAt` (cada llamada
// independiente a Local genera su propio timestamp real — no es una
// diferencia de comportamiento, solo de reloj).
function stripTimestamp(res) {
  const { generatedAt, ...rest } = res;
  return rest;
}

async function main() {
  await check('remote-response-provider.js no referencia DOM/SDKs de IA en código ejecutable (fetch SÍ es esperado en este archivo)', () => {
    const banned = ['XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const src = stripComments(fs.readFileSync(FILES.remoteProvider, 'utf8'));
    const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
    assert(hits.length === 0, `referencias prohibidas encontradas — ${hits.join(', ')}`);
    assert(src.includes('fetchFn(') && /typeof\s+fetch\b/.test(src), 'remote-response-provider.js debería llamar realmente a fetch() — no es otro placeholder inerte');
  });

  await check('feature-flags.js no referencia red/DOM/SDKs de IA en absoluto (mecanismo puro, sin efectos secundarios)', () => {
    const banned = ['fetch(', 'XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const src = stripComments(fs.readFileSync(FILES.featureFlags, 'utf8'));
    const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
    assert(hits.length === 0, `referencias prohibidas encontradas — ${hits.join(', ')}`);
  });

  await check('RemoteResponseProvider cumple el mismo ResponseProviderContract que Local/AI (verificado dinámicamente)', () => {
    const sandbox = freshSandbox();
    const run = c => vm.runInContext(c, sandbox);
    assert(run('ResponseProviderContract.implementedBy(RemoteResponseProvider) === true'),
      `RemoteResponseProvider no cumple el contrato — faltan: ${run('JSON.stringify(ResponseProviderContract.missingMethods(RemoteResponseProvider))')}`);
    run('ResponseProvider.use(RemoteResponseProvider);');
    assert(run('ResponseProvider.get() === RemoteResponseProvider'), 'ResponseProvider debería poder registrar RemoteResponseProvider como proveedor válido');
  });

  await check('FeatureFlags.isEnabled() es false por defecto (sin FEATURE_FLAGS global) y para cualquier flag desconocido', () => {
    const sandbox = freshSandbox();
    const run = c => vm.runInContext(c, sandbox);
    assert(run("FeatureFlags.isEnabled('remoteResponseProvider') === false"), 'debería ser false sin FEATURE_FLAGS definido');
    const sandbox2 = freshSandbox({ featureFlags: { remoteResponseProvider: true } });
    const run2 = c => vm.runInContext(c, sandbox2);
    assert(run2("FeatureFlags.isEnabled('otraCosa') === false"), 'un flag no listado explícitamente debería ser false');
    assert(run2("FeatureFlags.isEnabled('remoteResponseProvider') === true"), 'el flag explícitamente en true debería leerse como true');
  });

  // ---- Caso: flag desactivado (estado real de las tres páginas hoy) — debe comportarse EXACTAMENTE igual que Local ----
  await check('flag desactivado (por defecto): las 5 habilidades de RemoteResponseProvider son idénticas a LocalResponseProvider, sin llamar nunca a fetch', async () => {
    let fetchCalled = false;
    const sandbox = freshSandbox({ fetchImpl: () => { fetchCalled = true; return Promise.reject(new Error('fetch no debería llamarse con el flag desactivado')); } });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(17, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(52, { maxPerType: 300 });

        const [rExplain, lExplain] = await Promise.all([RemoteResponseProvider.explainProduct(ctxA), LocalResponseProvider.explainProduct(ctxA)]);
        const [rCompare, lCompare] = await Promise.all([RemoteResponseProvider.compareProducts(ctxA, ctxB), LocalResponseProvider.compareProducts(ctxA, ctxB)]);
        const [rBest, lBest] = await Promise.all([RemoteResponseProvider.bestAlternative(ctxA), LocalResponseProvider.bestAlternative(ctxA)]);
        const [rCross, lCross] = await Promise.all([RemoteResponseProvider.crossSell(ctxA), LocalResponseProvider.crossSell(ctxA)]);
        const [rPrice, lPrice] = await Promise.all([RemoteResponseProvider.priceAndAvailability(ctxA), LocalResponseProvider.priceAndAvailability(ctxA)]);

        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(rExplain)) === JSON.stringify(strip(lExplain))
          && JSON.stringify(strip(rCompare)) === JSON.stringify(strip(lCompare))
          && JSON.stringify(strip(rBest)) === JSON.stringify(strip(lBest))
          && JSON.stringify(strip(rCross)) === JSON.stringify(strip(lCross))
          && JSON.stringify(strip(rPrice)) === JSON.stringify(strip(lPrice));
      })()
    `);
    assert(ok, 'con el flag desactivado, alguna de las 5 habilidades de RemoteResponseProvider difiere de LocalResponseProvider');
    assert(!fetchCalled, 'con el flag desactivado, RemoteResponseProvider nunca debería intentar una llamada de red');
  });

  await check('flag activado pero SIN REMOTE_PROVIDER_CONFIG: cae a Local sin llamar a fetch', async () => {
    let fetchCalled = false;
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      fetchImpl: () => { fetchCalled = true; return Promise.reject(new Error('no debería llamarse sin config')); },
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const [r, l] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(r)) === JSON.stringify(strip(l));
      })()
    `);
    assert(ok, 'sin REMOTE_PROVIDER_CONFIG debería caer a Local');
    assert(!fetchCalled, 'sin REMOTE_PROVIDER_CONFIG.endpoint, no debería intentarse ninguna llamada de red');
  });

  await check('flag activado + config presente + fetch RECHAZA (fallo de red): cae a Local automáticamente', async () => {
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.reject(new Error('network down')),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const [r, l] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(r)) === JSON.stringify(strip(l));
      })()
    `);
    assert(ok, 'un fallo de red debería caer automáticamente a Local, con el mismo resultado');
  });

  await check('flag activado + config presente + fetch resuelve con ok:false (HTTP 500): cae a Local automáticamente', async () => {
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const [r, l] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(r)) === JSON.stringify(strip(l));
      })()
    `);
    assert(ok, 'una respuesta HTTP no exitosa debería caer automáticamente a Local, con el mismo resultado');
  });

  await check('flag activado + config presente + fetch resuelve ok pero con forma inesperada (skill no coincide): cae a Local automáticamente', async () => {
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ skill: 'algo-distinto' }) }),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const [r, l] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(r)) === JSON.stringify(strip(l));
      })()
    `);
    assert(ok, 'una respuesta remota con forma inesperada debería caer automáticamente a Local, con el mismo resultado');
  });

  await check('flag activado + config presente + fetch NUNCA resuelve (cuelgue de red): el timeout aborta la petición y cae a Local automáticamente', async () => {
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot', timeoutMs: 50 },
      // Simula el comportamiento real de fetch bajo AbortController: nunca
      // resuelve por sí sola, pero rechaza en cuanto se aborta la señal —
      // así se prueba que RemoteResponseProvider realmente arma y dispara
      // el AbortController, no que "por casualidad" nunca cuelga el test.
      fetchImpl: (url, opts) => new Promise((resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      }),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const start = Date.now();
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const [r, l] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(r)) === JSON.stringify(strip(l));
      })()
    `);
    const elapsedMs = Date.now() - start;
    assert(ok, 'un cuelgue de red debería, tras agotarse el timeout, caer automáticamente a Local, con el mismo resultado');
    assert(elapsedMs < 2000, `el timeout de 50ms debería haber abortado la petición mucho antes de ${elapsedMs}ms — el AbortController no parece estar funcionando`);
  });

  await check('flag activado + config presente + fetch resuelve ok con .json() que lanza (JSON inválido): cae a Local automáticamente', async () => {
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('Unexpected token')) }),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const [r, l] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
        const strip = (${stripTimestamp.toString()});
        return JSON.stringify(strip(r)) === JSON.stringify(strip(l));
      })()
    `);
    assert(ok, 'un cuerpo JSON inválido debería caer automáticamente a Local, con el mismo resultado');
  });

  // ---- Caso feliz: el remoto SÍ responde correctamente ----
  await check('flag activado + config presente + fetch resuelve con una respuesta válida: se devuelve el cuerpo remoto tal cual (no el de Local)', async () => {
    const remoteBody = { skill: 'explain-product', source: 'remote-test', generatedAt: '2026-01-01T00:00:00.000Z', text: 'Texto generado por el backend remoto simulado.' };
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(remoteBody) }),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const res = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const r = await RemoteResponseProvider.explainProduct(ctx);
        return JSON.stringify(r);
      })()
    `);
    assert(JSON.parse(res).text === remoteBody.text, 'debería devolver exactamente el cuerpo que entregó el backend remoto simulado, no el texto de Local');
    assert(JSON.parse(res).source === 'remote-test', 'el campo source debería venir tal cual del backend remoto, sin que este proveedor lo reescriba');
  });

  await check('compareProducts construye un PromptContext independiente para A y B, y los envía al endpoint remoto', async () => {
    let capturedBody = null;
    const remoteBody = { skill: 'compare-products', source: 'remote-test', generatedAt: '2026-01-01T00:00:00.000Z', productos: {}, similitudes: [], diferencias: [] };
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: (url, opts) => { capturedBody = opts.body; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(remoteBody) }); },
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    await run(`
      (async function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        await RemoteResponseProvider.compareProducts(ctxA, ctxB);
      })()
    `);
    assert(capturedBody, 'no se capturó el cuerpo de la petición fetch');
    const parsed = JSON.parse(capturedBody);
    assert(parsed.skill === 'compare-products', 'el payload enviado debería declarar el skill "compare-products"');
    const pcA = parsed.promptContext.a;
    const pcB = parsed.promptContext.b;
    const hasShape = pc => pc && pc.productKnowledge && pc.commercialContext && Array.isArray(pc.alternatives) && Array.isArray(pc.crossSell) && 'userIntent' in pc;
    assert(hasShape(pcA) && hasShape(pcB), 'el payload debería incluir dos PromptContext completos e independientes (A y B), no un stub');
    assert(pcA.productKnowledge.nombre !== pcB.productKnowledge.nombre || pcA !== pcB, 'los PromptContext de A y B no deberían ser el mismo objeto');
  });

  await check('un contexto inválido (null) rechaza con el mismo error que produciría LocalResponseProvider directamente', async () => {
    const sandbox = freshSandbox({ featureFlags: { remoteResponseProvider: true }, remoteConfig: { endpoint: 'https://example.invalid/copilot' } });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const outcome = await run(`
      (async function () {
        try {
          await RemoteResponseProvider.explainProduct(null);
          return 'resolved';
        } catch (e) {
          try { await LocalResponseProvider.explainProduct(null); return 'local-resolved'; }
          catch (le) { return e.message === le.message ? 'same-error' : 'different-error: ' + e.message + ' vs ' + le.message; }
        }
      })()
    `);
    assert(outcome === 'same-error', `se esperaba que ambos rechacen con el mismo mensaje; resultado: ${outcome}`);
  });

  await check('recorre TODO el catálogo con el flag desactivado (estado real de hoy): idéntico a Local en las 5 habilidades, sin excepciones', async () => {
    let fetchCalled = false;
    const sandbox = freshSandbox({ fetchImpl: () => { fetchCalled = true; return Promise.reject(new Error('no debería llamarse')); } });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        const strip = (${stripTimestamp.toString()});
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { maxPerType: 300 });
            const [rE, lE] = await Promise.all([RemoteResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
            if (JSON.stringify(strip(rE)) !== JSON.stringify(strip(lE))) fallos.push({ i, motivo: 'explainProduct difiere' });
            const [rP, lP] = await Promise.all([RemoteResponseProvider.priceAndAvailability(ctx), LocalResponseProvider.priceAndAvailability(ctx)]);
            if (JSON.stringify(strip(rP)) !== JSON.stringify(strip(lP))) fallos.push({ i, motivo: 'priceAndAvailability difiere' });
          } catch (e) { fallos.push({ i, motivo: e.message }); }
        }
        return fallos;
      })()
    `);
    assert(Array.isArray(bad) && bad.length === 0, `${bad.length} fallo(s): ${JSON.stringify(bad.slice(0, 5))}`);
    assert(!fetchCalled, 'con el flag desactivado, ningún producto del catálogo debería disparar una llamada de red');
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
    console.log('ALL REMOTE RESPONSE PROVIDER CHECKS PASSED');
  }
}

main();
