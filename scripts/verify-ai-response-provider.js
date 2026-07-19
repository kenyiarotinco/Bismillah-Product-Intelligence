/*
 * Smoke test headless para AIResponseProvider (Fase 5, Paso 1).
 *
 * AIResponseProvider es un delegado puro hacia RemoteResponseProvider — ver
 * assets/js/providers/ai-response-provider.js para el porqué. Esta suite no
 * re-implementa desde cero las pruebas de RemoteResponseProvider (ya
 * cubiertas exhaustivamente en scripts/verify-remote-response-provider.js);
 * en su lugar, prueba dos cosas específicas de este paso: (1) que la
 * delegación es exacta — mismos argumentos, mismo resultado, en cada uno de
 * los 5 métodos — y (2) que, ejercitada A TRAVÉS de AIResponseProvider, la
 * respuesta feliz (Gemini simulado) y los 6 modos de fallo mínimos exigidos
 * por la especificación (timeout, error HTTP, respuesta vacía, JSON
 * inválido, error del proxy, error del modelo) siguen cayendo
 * correctamente a LocalResponseProvider.
 *
 * Mismo criterio que el resto de la Fase 4/5: cero llamadas de red reales,
 * cero necesidad de una GEMINI_API_KEY — `fetch` se simula por escenario.
 *
 * Uso: node scripts/verify-ai-response-provider.js
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
const LOAD_ORDER = [
  'data', 'contextBuilder', 'promptContextBuilder', 'commercialDataProvider',
  'featureFlags', 'responseProviderContract', 'responseProvider', 'localProvider', 'remoteProvider', 'aiProvider',
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

function freshSandbox({ featureFlags, remoteConfig, fetchImpl } = {}) {
  const sandbox = {};
  vm.createContext(sandbox);
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

function stripTimestamp(res) {
  const { generatedAt, ...rest } = res;
  return rest;
}

function fakeGeminiHttpOk(skill, extraFields = {}) {
  return () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ skill, source: 'gemini', generatedAt: new Date().toISOString(), ...extraFields }),
  });
}

async function main() {
  await check('ai-response-provider.js no referencia red/DOM/SDKs de IA directamente en código ejecutable (delega todo en RemoteResponseProvider)', () => {
    const banned = ['XMLHttpRequest', 'document.', 'window.', 'gemini', 'openai', 'anthropic'];
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const src = stripComments(fs.readFileSync(FILES.aiProvider, 'utf8'));
    const hits = banned.filter(b => src.toLowerCase().includes(b.toLowerCase()));
    assert(hits.length === 0, `referencias prohibidas encontradas — ${hits.join(', ')}`);
  });

  await check('ResponseProviderContract.implementedBy(AIResponseProvider) === true', () => {
    const sandbox = freshSandbox();
    const run = c => vm.runInContext(c, sandbox);
    assert(run('ResponseProviderContract.implementedBy(AIResponseProvider) === true'),
      `faltan: ${run('JSON.stringify(ResponseProviderContract.missingMethods(AIResponseProvider))')}`);
  });

  // ---- Delegación exacta: mismo resultado que llamar a RemoteResponseProvider directamente ----
  await check('delegación exacta (flag desactivado, estado real de hoy): las 5 habilidades de AIResponseProvider son idénticas a RemoteResponseProvider', async () => {
    const sandbox = freshSandbox();
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctxA = ContextBuilder.build(17, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(52, { maxPerType: 300 });
        const strip = (${stripTimestamp.toString()});

        const [aExplain, rExplain] = await Promise.all([AIResponseProvider.explainProduct(ctxA), RemoteResponseProvider.explainProduct(ctxA)]);
        const [aCompare, rCompare] = await Promise.all([AIResponseProvider.compareProducts(ctxA, ctxB), RemoteResponseProvider.compareProducts(ctxA, ctxB)]);
        const [aBest, rBest] = await Promise.all([AIResponseProvider.bestAlternative(ctxA), RemoteResponseProvider.bestAlternative(ctxA)]);
        const [aCross, rCross] = await Promise.all([AIResponseProvider.crossSell(ctxA), RemoteResponseProvider.crossSell(ctxA)]);
        const [aPrice, rPrice] = await Promise.all([AIResponseProvider.priceAndAvailability(ctxA), RemoteResponseProvider.priceAndAvailability(ctxA)]);

        return JSON.stringify(strip(aExplain)) === JSON.stringify(strip(rExplain))
          && JSON.stringify(strip(aCompare)) === JSON.stringify(strip(rCompare))
          && JSON.stringify(strip(aBest)) === JSON.stringify(strip(rBest))
          && JSON.stringify(strip(aCross)) === JSON.stringify(strip(rCross))
          && JSON.stringify(strip(aPrice)) === JSON.stringify(strip(rPrice));
      })()
    `);
    assert(ok, 'alguna habilidad de AIResponseProvider difiere de llamar a RemoteResponseProvider directamente');
  });

  await check('un contexto inválido (null) rechaza con el mismo mensaje que RemoteResponseProvider/LocalResponseProvider', async () => {
    const sandbox = freshSandbox();
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const outcome = await run(`
      (async function () {
        let aMsg = null, rMsg = null;
        try { await AIResponseProvider.explainProduct(null); } catch (e) { aMsg = e.message; }
        try { await RemoteResponseProvider.explainProduct(null); } catch (e) { rMsg = e.message; }
        return aMsg === rMsg && typeof aMsg === 'string';
      })()
    `);
    assert(outcome, 'AIResponseProvider debería rechazar exactamente igual que RemoteResponseProvider ante un contexto inválido');
  });

  // ---- QA requerido #1: Gemini responde correctamente cuando está disponible ----
  await check('QA #1 — Gemini responde correctamente cuando está disponible: AIResponseProvider devuelve source:"gemini" con el contenido real del modelo simulado', async () => {
    const sandbox = freshSandbox({
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: fakeGeminiHttpOk('cross-sell', { recomendaciones: [{ sku: '1', nombre: 'Simulado', razon: 'ok' }], mensaje: null }),
    });
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const res = await run(`
      (async function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        return AIResponseProvider.crossSell(ctx);
      })()
    `);
    assert(res.source === 'gemini', `se esperaba source:"gemini", se obtuvo "${res.source}"`);
    assert(res.recomendaciones[0].nombre === 'Simulado', 'debería relayar el contenido exacto devuelto por el modelo simulado');
  });

  // ---- QA requerido #2: el fallback funciona para todos los errores previstos ----
  const fallbackScenarios = [
    ['flag deshabilitado (por defecto)', {}],
    ['sin REMOTE_PROVIDER_CONFIG', { featureFlags: { remoteResponseProvider: true } }],
    ['timeout (fetch nunca resuelve)', {
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot', timeoutMs: 50 },
      fetchImpl: (url, opts) => new Promise((resolve, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }],
    ['error HTTP (500)', {
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    }],
    ['respuesta vacía (cuerpo vacío, .json() falla al parsear)', {
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) }),
    }],
    ['JSON inválido', {
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token')) }),
    }],
    ['error del proxy (fetch rechaza — fallo de red hacia el proxy)', {
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    }],
    ['error del modelo (skill no coincide — contrato incumplido)', {
      featureFlags: { remoteResponseProvider: true },
      remoteConfig: { endpoint: 'https://example.invalid/copilot' },
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ skill: 'otro-skill' }) }),
    }],
  ];

  for (const [label, opts] of fallbackScenarios) {
    // eslint-disable-next-line no-await-in-loop
    await check(`QA #2 — fallback (${label}): AIResponseProvider.explainProduct cae a una respuesta válida de LocalResponseProvider, nunca un error visible`, async () => {
      const sandbox = freshSandbox(opts);
      const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
      const outcome = await run(`
        (async function () {
          const ctx = ContextBuilder.build(0, { maxPerType: 15 });
          const [a, l] = await Promise.all([AIResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
          const strip = (${stripTimestamp.toString()});
          return JSON.stringify(strip(a)) === JSON.stringify(strip(l));
        })()
      `);
      assert(outcome, `con el escenario "${label}", AIResponseProvider debería devolver exactamente la misma respuesta que LocalResponseProvider`);
    });
  }

  // ---- QA requerido #3: no existen regresiones en las respuestas locales ----
  await check('QA #3 — no existen regresiones: LocalResponseProvider, llamado directamente, sigue funcionando exactamente igual', async () => {
    const sandbox = freshSandbox();
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const ok = await run(`
      (async function () {
        const ctx = ContextBuilder.build(0, { maxPerType: 15 });
        const explain = await LocalResponseProvider.explainProduct(ctx);
        const price = await LocalResponseProvider.priceAndAvailability(ctx);
        return explain.skill === 'explain-product' && price.skill === 'price-availability';
      })()
    `);
    assert(ok, 'LocalResponseProvider dejó de funcionar como antes');
  });

  await check('recorre TODO el catálogo con el flag desactivado (estado real de hoy): AIResponseProvider idéntico a LocalResponseProvider, sin excepciones', async () => {
    const sandbox = freshSandbox();
    const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
    const n = run('DATA.products.length');
    const bad = await run(`
      (async function () {
        const fallos = [];
        const strip = (${stripTimestamp.toString()});
        for (let i = 0; i < DATA.products.length; i++) {
          try {
            const ctx = ContextBuilder.build(i, { maxPerType: 300 });
            const [a, l] = await Promise.all([AIResponseProvider.explainProduct(ctx), LocalResponseProvider.explainProduct(ctx)]);
            if (JSON.stringify(strip(a)) !== JSON.stringify(strip(l))) fallos.push({ i, motivo: 'explainProduct difiere' });
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
    console.log('ALL AI RESPONSE PROVIDER CHECKS PASSED');
  }
}

main();
