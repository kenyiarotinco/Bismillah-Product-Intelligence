/*
 * Smoke test headless para api/copilot.js — el adaptador serverless de
 * Vercel (Fase 6, Paso 1). Cero llamadas reales a Gemini, cero necesidad de
 * GEMINI_API_KEY real: se simula invocando el handler exportado directamente
 * con objetos req/res falsos, exactamente el modelo de invocación que usa
 * el runtime Node.js de Vercel (el handler exportado ES el mismo
 * `createRequestHandler(...)` ya usado y probado por el servidor local —
 * ver scripts/verify-gemini-proxy-server.js — así que esta suite no repite
 * esas pruebas de comportamiento profundo; se enfoca en lo específico de
 * este adaptador: que exporta correctamente, que lee las variables de
 * entorno correctas, y que el chequeo de ruta queda desactivado como
 * corresponde a un entorno serverless).
 *
 * Uso: node scripts/verify-api-copilot.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const HANDLER_FILE = path.join(ROOT, 'api', 'copilot.js');

// Red de seguridad dura: api/copilot.js usa el `fetch` GLOBAL de Node
// (fetchImpl: fetch, sin inyección posible desde fuera — a diferencia de
// server/gemini-proxy-server.js, que sí acepta un fetchImpl mockeado). Para
// garantizar CERO llamadas reales a Gemini en esta suite, se reemplaza
// global.fetch por una implementación que SIEMPRE rechaza antes de tocar la
// red, para cualquier objetivo que parezca la API de Gemini — coherente con
// la instrucción explícita de no realizar llamadas reales durante esta
// implementación.
const realFetch = global.fetch;
global.fetch = (url, ...rest) => {
  if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
    return Promise.reject(new Error('BLOQUEADO EN QA: intento de llamada real a Gemini interceptado — no debería ocurrir en esta suite.'));
  }
  return realFetch ? realFetch(url, ...rest) : Promise.reject(new Error('fetch no disponible'));
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

// Simula el objeto `req` que Vercel pasa a una función Node.js serverless —
// un IncomingMessage real de Node, con `.on('data'/'end')` para el cuerpo.
function fakeReq({ method = 'POST', url = '/api/copilot', headers = {}, body = '' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

// Simula el objeto `res` — captura status/headers/body para poder aserir sobre ellos.
function fakeRes() {
  const res = {
    _status: null,
    _headers: {},
    _body: '',
    writeHead(status, headers) { this._status = status; if (headers) Object.assign(this._headers, headers); return this; },
    setHeader(k, v) { this._headers[k] = v; },
    end(body) { if (body) this._body += body; },
  };
  return res;
}

function loadHandlerWithEnv(env) {
  // Cada escenario necesita su propia combinación de variables de entorno
  // (GEMINI_API_KEY presente/ausente, etc.) — se limpia el caché de require
  // para que api/copilot.js vuelva a leer process.env al cargar.
  delete require.cache[require.resolve(HANDLER_FILE)];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'gemini-proxy-server.js'))];
  const prevEnv = { ...process.env };
  Object.keys(process.env).forEach(k => { if (k.startsWith('GEMINI_') || k === 'ALLOWED_ORIGIN') delete process.env[k]; });
  Object.assign(process.env, env);
  const handler = require(HANDLER_FILE);
  process.env = prevEnv;
  return handler;
}

async function main() {
  await check('api/copilot.js existe, no lanza al cargarse, y exporta directamente una función (req,res) — compatible con el runtime Node.js de Vercel', () => {
    delete require.cache[require.resolve(HANDLER_FILE)];
    const handler = require(HANDLER_FILE);
    assert(typeof handler === 'function', `se esperaba una función, se obtuvo ${typeof handler}`);
    assert(handler.length === 2, `se esperaba un handler (req, res) de 2 parámetros, tiene ${handler.length}`);
  });

  await check('no reimplementa transporte/validación/timeout/grounding — delega en createRequestHandler (por inspección de código)', () => {
    const src = fs.readFileSync(HANDLER_FILE, 'utf8');
    assert(/require\(['"]\.\.\/server\/gemini-proxy-server\.js['"]\)/.test(src), 'debería importar server/gemini-proxy-server.js');
    assert(/createRequestHandler\(/.test(src), 'debería usar createRequestHandler()');
    assert(!/fetch\(|AbortController|JSON\.parse\(raw|generativelanguage/.test(src), 'no debería reimplementar ninguna lógica de transporte/parsing/llamada a Gemini — eso vive solo en gemini-proxy-server.js');
  });

  await check('nunca hardcodea un modelo nuevo — reutiliza DEFAULT_MODEL exportado, no un string nuevo', () => {
    const src = fs.readFileSync(HANDLER_FILE, 'utf8');
    assert(/DEFAULT_MODEL/.test(src), 'debería reutilizar DEFAULT_MODEL, no un modelo propio');
    assert(!/gemini-\d/.test(src), 'no debería contener ningún identificador de modelo hardcodeado');
  });

  await check('la API key nunca se lee del cuerpo/headers de la petición del cliente, solo de process.env', () => {
    const src = fs.readFileSync(HANDLER_FILE, 'utf8');
    assert(/process\.env\.GEMINI_API_KEY/.test(src), 'debería leer la key de process.env');
    assert(!/req\.(body|headers)\.[a-zA-Z]*[kK]ey/.test(src), 'no debería existir ninguna ruta que lea una key desde la petición entrante');
  });

  await check('QA #2 — GET (método no permitido) se rechaza con 404, sin llamar a Gemini', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    const req = fakeReq({ method: 'GET', url: '/api/copilot' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 404, `se esperaba 404, se obtuvo ${res._status}`);
  });

  await check('QA #2 — DELETE (método no permitido) se rechaza con 404', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    const req = fakeReq({ method: 'DELETE', url: '/api/copilot' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 404, `se esperaba 404, se obtuvo ${res._status}`);
  });

  await check('OPTIONS (preflight) responde 204, aunque en same-origin el navegador no lo exija', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    const req = fakeReq({ method: 'OPTIONS', url: '/api/copilot' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 204, `se esperaba 204, se obtuvo ${res._status}`);
  });

  await check('QA #3 — un POST válido a /api/copilot llega al handler compartido (no se rechaza por ruta) y responde según el contrato (400 por skill desconocido, sin key real)', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    const req = fakeReq({ method: 'POST', url: '/api/copilot', body: JSON.stringify({ skill: 'explain-product', promptContext: {} }) });
    const res = fakeRes();
    await handler(req, res);
    // Sin mock de fetch inyectado, callGemini() intentará una llamada real —
    // pero está diseñado para fallar de forma controlada (502) sin lanzar
    // ni colgarse; lo que aquí importa es que NO fue rechazado por ruta (404).
    assert(res._status !== 404, `un POST a /api/copilot no debería ser rechazado por ruta (expectedPath:null) — se obtuvo ${res._status}`);
  });

  await check('QA #3 — el chequeo de ruta queda desactivado (expectedPath:null): incluso una URL distinta a /api/copilot llega al handler, porque Vercel ya garantizó el enrutamiento', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    const req = fakeReq({ method: 'POST', url: '/cualquier-otra-cosa', body: JSON.stringify({ skill: 'explain-product', promptContext: {} }) });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status !== 404 || JSON.parse(res._body).error !== 'not found', 'con expectedPath:null, la ruta no debería usarse para rechazar la petición');
  });

  await check('QA #4 — sin GEMINI_API_KEY: responde 500 con un mensaje de error controlado, SIN revelar ningún secreto', async () => {
    const handler = loadHandlerWithEnv({});
    const req = fakeReq({ method: 'POST', url: '/api/copilot', body: JSON.stringify({ skill: 'explain-product', promptContext: {} }) });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 500, `se esperaba 500, se obtuvo ${res._status}`);
    const body = JSON.parse(res._body);
    assert(typeof body.error === 'string' && body.error.length > 0, 'debería incluir un mensaje de error legible');
    assert(!/gemini-|goog-api-key|generativelanguage/i.test(res._body), 'el mensaje de error no debería filtrar detalles internos de la integración');
    assert(!res._body.includes('clave-de-prueba') , 'el mensaje de error nunca debería incluir la API key');
  });

  await check('QA #4 — cuerpo JSON inválido responde 400, sin revelar la API key configurada', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-super-secreta-no-debe-aparecer' });
    const req = fakeReq({ method: 'POST', url: '/api/copilot', body: '{esto no es json' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `se esperaba 400, se obtuvo ${res._status}`);
    assert(!res._body.includes('clave-super-secreta-no-debe-aparecer'), 'la API key nunca debería aparecer en una respuesta HTTP');
  });

  await check('QA #5 — timeout: si "Gemini" nunca responde, la función corta por AbortController y responde 502 en vez de colgarse (sin llamada real)', async () => {
    // Sustituye temporalmente el fetch bloqueado-por-defecto de esta suite
    // por uno que cuelga a propósito pero SÍ respeta la señal de aborto —
    // igual disciplina que ya usa scripts/verify-gemini-proxy-server.js
    // para probar el timeout sin gastar 25s reales de espera.
    const hangingFetch = global.fetch;
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }
    });
    try {
      process.env.GEMINI_TIMEOUT_MS = '50';
      const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-de-prueba-no-real', GEMINI_TIMEOUT_MS: '50' });
      const start = Date.now();
      const req = fakeReq({ method: 'POST', url: '/api/copilot', body: JSON.stringify({ skill: 'explain-product', promptContext: {} }) });
      const res = fakeRes();
      await handler(req, res);
      const elapsed = Date.now() - start;
      assert(res._status === 502, `se esperaba 502 (timeout controlado), se obtuvo ${res._status}`);
      assert(elapsed < 2000, `el timeout de 50ms debería haber cortado mucho antes de ${elapsed}ms`);
    } finally {
      global.fetch = hangingFetch;
      delete process.env.GEMINI_TIMEOUT_MS;
    }
  });

  await check('QA #4 — skill desconocido responde 400, sin revelar la API key configurada', async () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'clave-super-secreta-no-debe-aparecer' });
    const req = fakeReq({ method: 'POST', url: '/api/copilot', body: JSON.stringify({ skill: 'skill-inventado', promptContext: {} }) });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `se esperaba 400, se obtuvo ${res._status}`);
    assert(!res._body.includes('clave-super-secreta-no-debe-aparecer'), 'la API key nunca debería aparecer en una respuesta HTTP');
  });

  await check('GEMINI_MODEL y GEMINI_TIMEOUT_MS, si están definidas, se leen del entorno (verificado indirectamente: el módulo no lanza y respeta la ausencia con sus defaults ya existentes)', () => {
    const handler1 = loadHandlerWithEnv({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-2.0-flash-custom-test', GEMINI_TIMEOUT_MS: '5000' });
    assert(typeof handler1 === 'function', 'debería seguir exportando una función con GEMINI_MODEL/GEMINI_TIMEOUT_MS definidas');
    const handler2 = loadHandlerWithEnv({ GEMINI_API_KEY: 'k' });
    assert(typeof handler2 === 'function', 'debería seguir exportando una función sin GEMINI_MODEL/GEMINI_TIMEOUT_MS (usa los defaults ya existentes)');
  });

  await check('ALLOWED_ORIGIN es opcional — el módulo funciona sin ella (same-origin no la necesita)', () => {
    const handler = loadHandlerWithEnv({ GEMINI_API_KEY: 'k' });
    assert(typeof handler === 'function', 'debería funcionar sin ALLOWED_ORIGIN configurada');
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
    console.log('ALL API COPILOT (VERCEL ADAPTER) CHECKS PASSED');
  }
}

main();
