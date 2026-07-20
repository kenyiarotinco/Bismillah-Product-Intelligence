/*
 * Smoke test headless para server/gemini-proxy-server.js (Fase 4, Pasos 4-5).
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
  validateGroundedSkuUsage, validateAvailabilityConsistency, classifyGeminiError, observeCopilotRequest,
  DEFAULT_MODEL, DEFAULT_TIMEOUT_MS,
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
  const logger = options.logger || { info() {}, warn() {} };
  const server = await startServer({ ...options, logger, port: 0, silent: true });
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function capturingLogger() {
  const entries = [];
  return {
    entries,
    info(message) { entries.push({ level: 'info', message }); },
    warn(message) { entries.push({ level: 'warn', message }); },
  };
}

function parseObservation(entry) {
  assert(entry && /^\[copilot\] /.test(entry.message), 'el log debe usar el prefijo [copilot]');
  return JSON.parse(entry.message.replace(/^\[copilot\] /, ''));
}

async function main() {
  await check('DEFAULT_MODEL usa el reemplazo vigente de Gemini 2.0 Flash', () => {
    assert(DEFAULT_MODEL === 'gemini-3.5-flash',
      `se esperaba gemini-3.5-flash, se obtuvo ${DEFAULT_MODEL}`);
  });

  await check('DEFAULT_TIMEOUT_MS concede 25s al backend y queda por debajo de los 30s del perfil AI Preview', () => {
    assert(DEFAULT_TIMEOUT_MS === 25000,
      `se esperaba un timeout backend de 25000ms, se obtuvo ${DEFAULT_TIMEOUT_MS}`);
    const preview = fs.readFileSync(path.join(ROOT, 'ai-preview', 'index.html'), 'utf8');
    assert(/timeoutMs:\s*30000/.test(preview), 'ai-preview debe declarar timeoutMs: 30000');
  });

  await check('classifyGeminiError reduce fallos a categorías operativas sin propagar mensajes', () => {
    assert(classifyGeminiError(new Error('Gemini API: tiempo de espera agotado (25000ms).')) === 'timeout', 'debería clasificar timeout');
    assert(classifyGeminiError(new Error('Gemini API respondió 429: detalle sensible')) === 'upstream_http', 'debería clasificar HTTP upstream');
    assert(classifyGeminiError(new Error('Gemini API: fallo de red — ENOTFOUND')) === 'network', 'debería clasificar fallo de red');
    assert(classifyGeminiError(new Error('Gemini API: la respuesta del modelo no es JSON válido')) === 'invalid_response', 'debería clasificar respuesta inválida');
    assert(classifyGeminiError(new Error('Gemini API: la respuesta del modelo no cumple la forma esperada')) === 'contract_mismatch', 'debería clasificar contrato');
    assert(classifyGeminiError(new Error('Gemini API: sku no está entre los candidatos')) === 'grounding_rejected', 'debería clasificar grounding');
    assert(classifyGeminiError(new Error('detalle desconocido')) === 'unknown', 'debería usar unknown como cierre seguro');
  });

  await check('observabilidad: una comparación simulada con latencia controlada termina en 200 y registra solo metadatos seguros', async () => {
    const logger = capturingLogger();
    const response = await fakeGeminiOk('compare-products', {
      productos: { a: {}, b: {} },
      similitudes: ['detalle-de-respuesta-no-debe-loguearse'],
      diferencias: [],
    })();
    await withServer({
      apiKey: 'clave-super-secreta-no-debe-loguearse',
      timeoutMs: 200,
      logger,
      fetchImpl: () => new Promise(resolve => setTimeout(() => resolve(response), 40)),
    }, async base => {
      const res = await fetch(`${base}/copilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skill: 'compare-products',
          promptContext: { a: { productKnowledge: { nombre: 'PRODUCTO-PRIVADO-A' } }, b: { productKnowledge: { nombre: 'PRODUCTO-PRIVADO-B' } } },
        }),
      });
      assert(res.status === 200, `la comparación simulada debería responder 200, se obtuvo ${res.status}`);
    });
    assert(logger.entries.length === 1, `se esperaba exactamente un evento, se obtuvieron ${logger.entries.length}`);
    assert(logger.entries[0].level === 'info', 'una respuesta exitosa debe registrarse con nivel info');
    const event = parseObservation(logger.entries[0]);
    assert(event.event === 'copilot_request' && event.skill === 'compare-products' && event.outcome === 'success', 'el evento exitoso debe identificar habilidad y resultado');
    assert(Number.isInteger(event.durationMs) && event.durationMs >= 30, 'el evento debe registrar una duración entera coherente con la latencia simulada');
    assert(JSON.stringify(Object.keys(event).sort()) === JSON.stringify(['durationMs', 'event', 'outcome', 'skill']), 'el evento exitoso no debe incluir campos adicionales');
    const serialized = JSON.stringify(logger.entries);
    assert(!/clave-super-secreta|PRODUCTO-PRIVADO|detalle-de-respuesta/i.test(serialized), 'el log no debe incluir key, PromptContext ni respuesta');
  });

  await check('observabilidad: un timeout simulado registra category:"timeout" sin filtrar key, PromptContext ni mensaje interno', async () => {
    const logger = capturingLogger();
    await withServer({
      apiKey: 'otra-clave-super-secreta',
      timeoutMs: 50,
      logger,
      fetchImpl: (url, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('DETALLE-INTERNO-DE-RED')));
      }),
    }, async base => {
      const res = await fetch(`${base}/copilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: 'compare-products', promptContext: { dato: 'CONTEXTO-PRIVADO' } }),
      });
      assert(res.status === 502, `el timeout simulado debería responder 502, se obtuvo ${res.status}`);
    });
    assert(logger.entries.length === 1, `se esperaba exactamente un evento, se obtuvieron ${logger.entries.length}`);
    assert(logger.entries[0].level === 'warn', 'un timeout debe registrarse con nivel warn');
    const event = parseObservation(logger.entries[0]);
    assert(event.event === 'copilot_request' && event.skill === 'compare-products' && event.outcome === 'error' && event.category === 'timeout', 'el evento debe clasificar el timeout sin ambigüedad');
    assert(Number.isInteger(event.durationMs) && event.durationMs >= 40, 'el evento debe registrar la duración hasta el aborto');
    assert(JSON.stringify(Object.keys(event).sort()) === JSON.stringify(['category', 'durationMs', 'event', 'outcome', 'skill']), 'el evento de error no debe incluir campos adicionales');
    const serialized = JSON.stringify(logger.entries);
    assert(!/otra-clave|CONTEXTO-PRIVADO|DETALLE-INTERNO/i.test(serialized), 'el log no debe incluir key, PromptContext ni mensaje interno');
  });

  await check('observabilidad: un logger defectuoso nunca altera el flujo principal', () => {
    observeCopilotRequest({ info() { throw new Error('logger no disponible'); } }, 'info', {
      skill: 'compare-products', outcome: 'success', durationMs: 10,
    });
  });

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

  await check('validateGroundedSkuUsage() (Paso 5): rechaza una "mejor alternativa" cuyo sku no está en promptContext.alternatives', () => {
    const promptContext = { alternatives: [{ sku: 'SKU-REAL', nombre: 'Real' }] };
    let threw = null;
    try {
      validateGroundedSkuUsage('best-alternative', promptContext, { encontrado: true, alternativa: { sku: 'SKU-INVENTADO' } });
    } catch (e) { threw = e; }
    assert(threw && /no está entre los candidatos/.test(threw.message), 'debería rechazar un sku de alternativa que no está entre los candidatos');

    // sku real: no debería lanzar
    validateGroundedSkuUsage('best-alternative', promptContext, { encontrado: true, alternativa: { sku: 'SKU-REAL' } });
    // encontrado:false sin alternativa: no debería lanzar (nada que validar)
    validateGroundedSkuUsage('best-alternative', promptContext, { encontrado: false, alternativa: null });
  });

  await check('validateGroundedSkuUsage() (Paso 5): rechaza cualquier recomendación de crossSell cuyo sku no está en promptContext.crossSell', () => {
    const promptContext = { crossSell: [{ sku: 'SKU-A' }, { sku: 'SKU-B' }] };
    let threw = null;
    try {
      validateGroundedSkuUsage('cross-sell', promptContext, { recomendaciones: [{ sku: 'SKU-A' }, { sku: 'SKU-INVENTADO' }] });
    } catch (e) { threw = e; }
    assert(threw && /no está entre los candidatos/.test(threw.message), 'debería rechazar si al menos una recomendación tiene un sku fuera de los candidatos');

    // todos reales: no debería lanzar
    validateGroundedSkuUsage('cross-sell', promptContext, { recomendaciones: [{ sku: 'SKU-A' }, { sku: 'SKU-B' }] });
    // lista vacía: no debería lanzar
    validateGroundedSkuUsage('cross-sell', promptContext, { recomendaciones: [] });
  });

  await check('validateAvailabilityConsistency() (Paso 5): rechaza disponible:true cuando el PromptContext indica disponibilidad:false', () => {
    const promptContext = { commercialContext: { disponibilidad: false } };
    let threw = null;
    try {
      validateAvailabilityConsistency('price-availability', promptContext, { disponible: true, precio: 39.9 });
    } catch (e) { threw = e; }
    assert(threw && /reportó disponibilidad/.test(threw.message), 'debería rechazar disponible:true cuando el contexto real no tiene cobertura comercial');

    // consistente: no debería lanzar
    validateAvailabilityConsistency('price-availability', promptContext, { disponible: false, precio: null });
    // otra habilidad: no aplica, no debería lanzar aunque los campos "parezcan" inconsistentes
    validateAvailabilityConsistency('explain-product', promptContext, { disponible: true });
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
  // Se construye el sandbox del cliente ANTES de levantar el servidor para
  // poder leer, del PromptContext REAL de un producto real, un candidato
  // legítimo de "crossSell" — desde el Paso 5, gemini-proxy-server.js
  // rechaza cualquier sku que el modelo simulado devuelva y que no esté
  // entre esos candidatos (validateGroundedSkuUsage), así que la respuesta
  // fabricada del "Gemini" simulado debe usar un sku real, no uno inventado
  // como en la versión de este test del Paso 4.
  function buildClientSandbox(base) {
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
    if (base) vm.runInContext(`var REMOTE_PROVIDER_CONFIG = { endpoint: ${JSON.stringify(base + '/copilot')} };`, sandbox);
    for (const key of ['data', 'contextBuilder', 'promptContextBuilder', 'commercialDataProvider', 'featureFlags', 'responseProviderContract', 'responseProvider', 'localProvider', 'remoteProvider']) {
      vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
    }
    return sandbox;
  }

  await check('END-TO-END: RemoteResponseProvider, hablando HTTP real contra este proxy real, recibe y relaya la respuesta del "Gemini" simulado (5 habilidades)', async () => {
    // Sandbox "solo lectura" (sin servidor real) para calcular, de un producto
    // real del catálogo, un PromptContext real y un candidato real de crossSell.
    const readSandbox = buildClientSandbox(null);
    const readRun = code => vm.runInContext(code, readSandbox, { filename: 'assert.js' });
    const candidato = readRun(`
      (function () {
        const ctx = ContextBuilder.build(52, { maxPerType: 300 });
        const pc = PromptContextBuilder.build(ctx);
        return JSON.stringify(pc.crossSell[0]);
      })()
    `);
    const candidatoReal = JSON.parse(candidato);
    assert(candidatoReal && candidatoReal.sku, 'el producto de prueba (índice 52) debería tener al menos un candidato real de crossSell');

    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('cross-sell', { recomendaciones: [{ sku: candidatoReal.sku, nombre: candidatoReal.nombre, razon: 'prueba end-to-end' }], mensaje: null }) }, async base => {
      const sandbox = buildClientSandbox(base);
      const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
      const res = await run(`
        (async function () {
          const ctx = ContextBuilder.build(52, { maxPerType: 300 });
          return RemoteResponseProvider.crossSell(ctx);
        })()
      `);
      assert(res.source === 'gemini', `se esperaba source:"gemini" (respuesta remota genuina), se obtuvo "${res.source}" — ¿cayó a Local sin querer? (la validación de grounding del Paso 5 pudo haber rechazado la respuesta)`);
      assert(res.recomendaciones[0].sku === candidatoReal.sku, 'la respuesta debería contener el sku real devuelto por el "Gemini" simulado, propagado íntegro a través de HTTP real');
    });
  });

  await check('END-TO-END (grounding, Paso 5): un sku de crossSell INVENTADO por el "Gemini" simulado se rechaza y cae a Local, no se propaga al cliente', async () => {
    await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk('cross-sell', { recomendaciones: [{ sku: 'sku-inventado-que-no-existe', nombre: 'Producto Falso', razon: '...' }], mensaje: null }) }, async base => {
      const sandbox = buildClientSandbox(base);
      const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
      const res = await run(`
        (async function () {
          const ctx = ContextBuilder.build(52, { maxPerType: 300 });
          return RemoteResponseProvider.crossSell(ctx);
        })()
      `);
      assert(res.source === 'local', 'una recomendación con un sku fuera de los candidatos reales debería ser rechazada por el proxy y causar fallback automático a Local');
    });
  });

  await check('END-TO-END (5 habilidades reales): cada una de las 5 habilidades, con un PromptContext real, recibe correctamente una respuesta remota "gemini" válida a través de HTTP real', async () => {
    const readSandbox = buildClientSandbox(null);
    const readRun = code => vm.runInContext(code, readSandbox, { filename: 'assert.js' });

    const escenarios = JSON.parse(readRun(`
      (function () {
        const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
        const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
        const ctx17 = ContextBuilder.build(17, { maxPerType: 300 });
        const ctx52 = ContextBuilder.build(52, { maxPerType: 300 });
        const pcA = PromptContextBuilder.build(ctxA);
        const pc17 = PromptContextBuilder.build(ctx17);
        const pc52 = PromptContextBuilder.build(ctx52);
        return JSON.stringify({
          alternativeSku: (pc17.alternatives[0] || {}).sku || null,
          crossSellSku: (pc52.crossSell[0] || {}).sku || null,
          crossSellNombre: (pc52.crossSell[0] || {}).nombre || null,
          alternativeNombre: (pc17.alternatives[0] || {}).nombre || null,
        });
      })()
    `));

    for (const skill of ['explain-product', 'compare-products', 'best-alternative', 'cross-sell', 'price-availability']) {
      let fakeBody;
      if (skill === 'explain-product') fakeBody = { text: 'Explicación generada por Gemini simulado.' };
      else if (skill === 'compare-products') fakeBody = { productos: { a: {}, b: {} }, similitudes: ['similitud simulada'], diferencias: [] };
      else if (skill === 'best-alternative') fakeBody = { encontrado: true, alternativa: { sku: escenarios.alternativeSku, nombre: escenarios.alternativeNombre }, afinidad: 'Alta', justificacion: 'justificación simulada', mensaje: null };
      else if (skill === 'cross-sell') fakeBody = { recomendaciones: [{ sku: escenarios.crossSellSku, nombre: escenarios.crossSellNombre, razon: 'razón simulada' }], mensaje: null };
      else fakeBody = { disponible: false, precio: null, precioLista: null, priceDifference: null, stock: null, estado: null, mensaje: 'sin cobertura comercial (simulado)' };

      // eslint-disable-next-line no-await-in-loop
      await withServer({ apiKey: 'k', fetchImpl: fakeGeminiOk(skill, fakeBody) }, async base => {
        const sandbox = buildClientSandbox(base);
        const run = code => vm.runInContext(code, sandbox, { filename: 'assert.js' });
        const res = await run(`
          (async function () {
            if (${JSON.stringify(skill)} === 'compare-products') {
              const ctxA = ContextBuilder.build(0, { maxPerType: 300 });
              const ctxB = ContextBuilder.build(1, { maxPerType: 300 });
              return RemoteResponseProvider.compareProducts(ctxA, ctxB);
            }
            const idx = ${JSON.stringify(skill)} === 'best-alternative' ? 17 : (${JSON.stringify(skill)} === 'cross-sell' ? 52 : 0);
            const ctx = ContextBuilder.build(idx, { maxPerType: 300 });
            return RemoteResponseProvider[${JSON.stringify(
              { 'explain-product': 'explainProduct', 'best-alternative': 'bestAlternative', 'cross-sell': 'crossSell', 'price-availability': 'priceAndAvailability' }[skill]
            )}](ctx);
          })()
        `);
        assert(res.source === 'gemini', `[${skill}] se esperaba source:"gemini", se obtuvo "${res.source}"`);
        assert(res.skill === skill, `[${skill}] se esperaba skill:"${skill}", se obtuvo "${res.skill}"`);
      });
    }
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
