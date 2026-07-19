/*
 * Smoke test headless para server/gemini-proxy-server.js (Fase 4, Paso 4).
 *
 * Este servidor SÍ es HTTP real (se levanta en un puerto local con
 * http.createServer) — lo que se simula es únicamente la llamada SALIENTE
 * a la API de Gemini (`fetchImpl`, inyectado). Ninguna verificación de este
 * archivo requiere una GEMINI_API_KEY real ni realiza una llamada de red
 * real a Google — mismo criterio ya usado en scripts/verify-remote-
 * response-provider.js para el lado del cliente.
 *
 * Además de probar el servidor de forma aislada, la última verificación es
 * un end-to-end genuino: RemoteResponseProvider (cargado en un sandbox de
 * vm, con el `fetch` REAL de Node inyectado) habla por HTTP real contra
 * esta instancia real del proxy, que a su vez usa un `fetchImpl` simulado
 * para "Gemini". Es la prueba más fuerte posible de que el cableado
 * completo funciona, sin gastar ni una llamada real a la API de Gemini.
 *
 * Uso: node scripts/verify-gemini-proxy-server.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  startServer, createRequestHandler, callGemini, buildPrompt, isOriginAllowed, SKILL_SCHEMAS,
} = require('../server/gemini-proxy-server.js');

const ROOT = path.join(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'server', 'gemini-proxy-server.js');

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

function fakeGeminiOk(skill, extraFields = {}) {
  const body = { skill, ...extraFields };
  return () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
    }),
  });
}

async function withServer(options, fn) {
  const server = await startServer({ ...options, port: 0, silent: true });
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  await check('gemini-proxy-server.js referencia fetch/http real (integración genuina, no otro placeholder) y no referencia SDKs de otros proveedores', () => {
    const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const src = stripComments(fs.readFileSync(SERVER_FILE, 'utf8'));
    assert(/generativelanguage\.googleapis\.com/.test(src), 'debería apuntar realmente a la API de Gemini');
    assert(!/openai|anthropic/i.test(src), 'este archivo es específico de Gemini — no debería referenciar otros SDKs de IA');
  });

  await check('la API key nunca se lee del cuerpo de la petición del cliente, solo de options.apiKey/process.env', () => {
    const src = fs.readFileSync(SERVER_FILE, 'utf8');
    // La única referencia a "apiKey" dentro del handler debe venir de las opciones
    // ya resueltas en startServer() (a su vez desde process.env) — nunca de `payload`.
    assert(!/payload\.apiKey|body\.apiKey|req\.headers\['?x-api-key'?\]/i.test(src),
      'no debería existir ninguna ruta que acepte la API key desde la petición entrante');
  });

  await check('buildPrompt incluye el PromptContext completo y la regla de "no inventar datos"', () => {
    const promptContext = { productKnowledge: { nombre: 'Producto de prueba' } };
    const prompt = buildPrompt('explain-product', promptContext);
    assert(prompt.includes('Producto de prueba'), 'el prompt debería incluir el contenido real del PromptContext');
    assert(/nunca inventes/i.test(prompt), 'el prompt debería instruir explícitamente no inventar datos');
    assert(prompt.includes(SKILL_SCHEMAS['explain-product']), 'el prompt debería incluir el schema de salida esperado para ese skill');
  });

  await check('isOriginAllowed: sin ALLOWED_ORIGIN, solo permite localhost/127.0.0.1; con ALLOWED_ORIGIN, solo permite ese origen exacto', () => {
    assert(isOriginAllowed('http://localhost:5500', undefined) === true, 'localhost debería permitirse por defecto');
    assert(isOriginAllowed('http://127.0.0.1:8080', undefined) === true, '127.0.0.1 debería permitirse por defecto');
    assert(isOriginAllowed('https://ejemplo-cualquiera.com', undefined) === false, 'un origen externo no debería permitirse sin ALLOWED_ORIGIN configurado');
    assert(isOriginAllowed('https://miapp.com', 'https://miapp.com') === true, 'el origen configurado explícitamente debería permitirse');
    assert(isOriginAllowed('https://otraapp.com', 'https://miapp.com') === false, 'un origen distinto al configurado no debería permitirse');
  });

  await check('callGemini(): construye la URL con el modelo correcto, envía la API key por header (nunca por query string) y parsea la respuesta', async () => {
    let capturedUrl = null, capturedHeaders = null;
    const result = await callGemini({
      skill: 'explain-product',
      promptContext: {},
      apiKey: 'clave-de-prueba',
      model: 'gemini-test-model',
      timeoutMs: 5000,
      fetchImpl: (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: JSON.stringify({ skill: 'explain-product', text: 'ok' }) }] } }] }),
        });
      },
    });
    assert(capturedUrl.includes('gemini-test-model'), 'la URL debería incluir el modelo configurado');
    assert(!capturedUrl.includes('clave-de-prueba'), 'la API key NUNCA debería viajar en la URL/query string');
    assert(capturedHeaders['x-goog-api-key'] === 'clave-de-prueba', 'la API key debería enviarse por el header x-goog-api-key');
    assert(result.skill === 'explain-product' && result.text === 'ok', 'el resultado debería traer el contenido real devuelto por el modelo simulado');
    assert(result.source === 'gemini', 'el servidor debería fijar source:"gemini" él mismo, no confiar en que el modelo lo incluya');
    assert(typeof result.generatedAt === 'string' && !Number.isNaN(Date.parse(result.generatedAt)), 'generatedAt debería ser una fecha ISO válida fijada por el servidor');
  });

  await check('callGemini(): una respuesta HTTP no exitosa de Gemini se traduce en un error claro', async () => {
    let threw = null;
    try {
      await callGemini({
        skill: 'explain-product', promptContext: {}, apiKey: 'k', model: 'm', timeoutMs: 5000,
        fetchImpl: () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('rate limited') }),
      });
    } catch (e) { threw = e; }
    assert(threw && /429/.test(threw.message), 'debería lanzar un error que mencione el status HTTP real de Gemini');
  });

  await check('callGemini(): un fallo de red hacia Gemini se traduce en un error claro (no un crash)', async () => {
    let threw = null;
    try {
      await callGemini({
        skill: 'explain-product', promptContext: {}, apiKey: 'k', model: 'm', timeoutMs: 5000,
        fetchImpl: () => Promise.reject(new Error('ENOTFOUND')),
      });
    } catch (e) { threw = e; }
    assert(threw && /fallo de red/i.test(threw.message), 'debería lanzar un error legible ante un fallo de red hacia Gemini');
  });

  await check('callGemini(): timeout hacia Gemini realmente aborta la petición saliente', async () => {
    const start = Date.now();
    let threw = null;
    try {
      await callGemini({
        skill: 'explain-product', promptContext: {}, apiKey: 'k', model: 'm', timeoutMs: 50,
        fetchImpl: (url, opts) => new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      });
    } catch (e) { threw = e; }
    const elapsed = Date.now() - start;
    assert(threw && /tiempo de espera agotado/i.test(threw.message), 'debería lanzar un error de timeout');
    assert(elapsed < 2000, `el timeout de 50ms debería haber abortado mucho antes de ${elapsed}ms`);
  });

  await check('callGemini(): texto del modelo que no es JSON válido se rechaza con un error claro (no crashea el servidor)', async () => {
    let threw = null;
    try {
      await callGemini({
        skill: 'explain-product', promptContext: {}, apiKey: 'k', model: 'm', timeoutMs: 5000,
        fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'esto no es JSON' }] } }] }) }),
      });
    } catch (e) { threw = e; }
    assert(threw && /JSON válido/.test(threw.message), 'debería rechazar texto que no parsea como JSON');
  });

  await check('callGemini(): JSON válido pero con "skill" distinto al solicitado se rechaza (contrato incumplido)', async () => {
    let threw = null;
    try {
      await callGemini({
        skill: 'explain-product', promptContext: {}, apiKey: 'k', model: 'm', timeoutMs: 5000,
        fetchImpl: fakeGeminiOk('compare-products'),
      });
    } catch (e) { threw = e; }
    assert(threw && /no cumple la forma esperada/.test(threw.message), 'un skill que no coincide debería rechazarse');
  });

  // ---- servidor HTTP real (puerto efímero), fetch a Gemini simulado ----
  await check('servidor real: responde 500 sin GEMINI_API_KEY, y nunca intenta llamar a Gemini', async () => {
    let fetchCalled = false;
    await withServer({ apiKey: '', fetchImpl: () => { fetchCalled = true; return fakeGeminiOk('explain-product')(); } }, async base => {
      const res = await fetch(`${base}/copilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost:5500' },
        body: JSON.stringify({ skill: 'explain-product', promptContext: {} }),
      });
      assert(res.status === 500, `se esperaba 500 sin API key configurada, se obtuvo ${res.status}`);
    });
    assert(!fetchCalled, 'sin API key, el servidor nunca debería intentar llamar a Gemini');
  });

  await check('servidor real: OPTIONS (preflight CORS) responde 204 con las cabeceras esperadas para un origen localhost', async () => {
    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('explain-product') }, async base => {
      const res = await fetch(`${base}/copilot`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5500' } });
      assert(res.status === 204, `se esperaba 204, se obtuvo ${res.status}`);
      assert(res.headers.get('access-control-allow-origin') === 'http://localhost:5500', 'debería reflejar el origen localhost en la cabecera CORS');
    });
  });

  await check('servidor real: ruta o método incorrecto responde 404', async () => {
    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('explain-product') }, async base => {
      const resGet = await fetch(`${base}/copilot`, { method: 'GET' });
      assert(resGet.status === 404, `GET /copilot debería ser 404, se obtuvo ${resGet.status}`);
      const resOtherPath = await fetch(`${base}/otra-ruta`, { method: 'POST', body: '{}' });
      assert(resOtherPath.status === 404, `POST /otra-ruta debería ser 404, se obtuvo ${resOtherPath.status}`);
    });
  });

  await check('servidor real: cuerpo JSON inválido responde 400; skill desconocido responde 400', async () => {
    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('explain-product') }, async base => {
      const resBadJson = await fetch(`${base}/copilot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{esto no es json' });
      assert(resBadJson.status === 400, `cuerpo inválido debería ser 400, se obtuvo ${resBadJson.status}`);
      const resBadSkill = await fetch(`${base}/copilot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill: 'algo-inventado', promptContext: {} }) });
      assert(resBadSkill.status === 400, `skill desconocido debería ser 400, se obtuvo ${resBadSkill.status}`);
    });
  });

  await check('servidor real: ruta feliz — devuelve 200 con el cuerpo normalizado (source:"gemini") cuando "Gemini" responde correctamente', async () => {
    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('price-availability', { disponible: true, precio: 39.9 }) }, async base => {
      const res = await fetch(`${base}/copilot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill: 'price-availability', promptContext: { productKnowledge: {} } }) });
      assert(res.status === 200, `se esperaba 200, se obtuvo ${res.status}`);
      const body = await res.json();
      assert(body.skill === 'price-availability' && body.disponible === true && body.precio === 39.9, 'el cuerpo debería reflejar el contenido simulado del modelo');
      assert(body.source === 'gemini', 'el source debería ser "gemini"');
    });
  });

  await check('servidor real: cuando "Gemini" falla (HTTP 500 simulado), el proxy responde 502 sin crashear', async () => {
    await withServer({ apiKey: 'k', fetchImpl: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') }) }, async base => {
      const res = await fetch(`${base}/copilot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill: 'explain-product', promptContext: {} }) });
      assert(res.status === 502, `se esperaba 502, se obtuvo ${res.status}`);
      const body = await res.json();
      assert(typeof body.error === 'string' && body.error.length > 0, 'debería incluir un mensaje de error legible');
    });
  });

  // ---- end-to-end genuino: RemoteResponseProvider (cliente real) -> HTTP real -> proxy real -> "Gemini" simulado ----
  await check('END-TO-END: RemoteResponseProvider, hablando HTTP real contra este proxy real, recibe y relaya la respuesta del "Gemini" simulado', async () => {
    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('cross-sell', { recomendaciones: [{ sku: '999', nombre: 'Producto E2E', razon: 'prueba end-to-end' }], mensaje: null }) }, async base => {
      const ROOT_DIR = path.join(__dirname, '..');
      const FILES = {
        data: path.join(ROOT_DIR, 'assets', 'js', 'data.js'),
        contextBuilder: path.join(ROOT_DIR, 'assets', 'js', 'context-builder.js'),
        promptContextBuilder: path.join(ROOT_DIR, 'assets', 'js', 'prompt-context-builder.js'),
        commercialDataProvider: path.join(ROOT_DIR, 'assets', 'js', 'commercial-data-provider.js'),
        featureFlags: path.join(ROOT_DIR, 'assets', 'js', 'feature-flags.js'),
        responseProviderContract: path.join(ROOT_DIR, 'assets', 'js', 'response-provider-contract.js'),
        responseProvider: path.join(ROOT_DIR, 'assets', 'js', 'response-provider.js'),
        localProvider: path.join(ROOT_DIR, 'assets', 'js', 'providers', 'local-response-provider.js'),
        remoteProvider: path.join(ROOT_DIR, 'assets', 'js', 'providers', 'remote-response-provider.js'),
      };
      const sandbox = {};
      vm.createContext(sandbox);
      sandbox.fetch = fetch; // fetch REAL de Node — la llamada HTTP hacia el proxy es real
      sandbox.setTimeout = setTimeout;
      sandbox.clearTimeout = clearTimeout;
      sandbox.AbortController = AbortController;
      vm.runInContext(`var FEATURE_FLAGS = { remoteResponseProvider: true };`, sandbox);
      vm.runInContext(`var REMOTE_PROVIDER_CONFIG = { endpoint: ${JSON.stringify(base + '/copilot')} };`, sandbox);
      for (const key of ['data', 'contextBuilder', 'promptContextBuilder', 'commercialDataProvider', 'featureFlags', 'responseProviderContract', 'responseProvider', 'localProvider', 'remoteProvider']) {
        vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
      }
      const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
      const res = await run(`
        (async function () {
          const ctx = ContextBuilder.build(52, { maxPerType: 300 });
          return RemoteResponseProvider.crossSell(ctx);
        })()
      `);
      assert(res.source === 'gemini', `se esperaba source:"gemini" (respuesta remota genuina), se obtuvo "${res.source}" — ¿cayó a Local sin querer?`);
      assert(res.recomendaciones[0].nombre === 'Producto E2E', 'la respuesta debería contener el contenido devuelto por el "Gemini" simulado, propagado íntegro a través de HTTP real');
    });
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
    console.log('ALL GEMINI PROXY SERVER CHECKS PASSED');
  }
}

main();
