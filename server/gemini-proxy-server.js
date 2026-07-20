#!/usr/bin/env node
/* Bismillah Product Intelligence Platform — Gemini Proxy Server (Fase 4, Pasos 4-5)
 *
 * Única pieza de todo el sistema que sabe cómo hablar con la API oficial de
 * Google AI Studio (Gemini). Es la respuesta al requisito de que "la API
 * key debe almacenarse exclusivamente en el backend o mediante variables de
 * entorno; nunca en el frontend": el proyecto era, hasta este paso,
 * explícitamente "sin backend, sin build step" (ver docs/PROJECT_BRIEF.md).
 * Este servidor es la primera y única excepción a esa regla, y existe
 * exclusivamente para que la API key de Gemini nunca viaje al navegador.
 *
 * Nada en `assets/js/` (el código que se sirve al navegador) importa ni
 * conoce este archivo. `RemoteResponseProvider` (assets/js/providers/remote-
 * response-provider.js) solo sabe que existe "un endpoint HTTP que recibe
 * {skill, promptContext} y responde con la forma del contrato" — exactamente
 * el mismo endpoint genérico que ya esperaba desde la Fase 4, Paso 3, antes
 * de que este servidor existiera. Mantener esa frontera es lo que permite
 * que un futuro proveedor (OpenAI, Claude) se agregue como
 * server/openai-proxy-server.js sin tocar ni una línea de
 * remote-response-provider.js ni del resto del pipeline comercial.
 *
 * Cómo ejecutarlo:
 *   GEMINI_API_KEY=<tu-key> node server/gemini-proxy-server.js
 * Variables de entorno soportadas (todas opcionales salvo GEMINI_API_KEY):
 *   GEMINI_API_KEY     — obligatoria para responder con éxito; sin ella, el
 *                         servidor arranca igual (para poder probarlo) pero
 *                         responde 500 a toda petición real.
 *   GEMINI_MODEL        — modelo de Gemini a usar (default: ver DEFAULT_MODEL).
 *   PORT                 — puerto HTTP (default: ver DEFAULT_PORT).
 *   GEMINI_TIMEOUT_MS   — tiempo máximo de espera a la API de Gemini antes
 *                         de abortar (default: ver DEFAULT_TIMEOUT_MS).
 *   ALLOWED_ORIGIN       — origen exacto permitido por CORS. Si no se define,
 *                         solo se permiten orígenes localhost/127.0.0.1 (uso
 *                         de desarrollo local) — un despliegue real DEBE
 *                         definir esta variable explícitamente.
 *
 * Este archivo NUNCA acepta la API key desde la petición del cliente (body,
 * query string o header) — solo desde `process.env.GEMINI_API_KEY`, leída
 * una vez al arrancar. El cliente (RemoteResponseProvider) nunca la ve, ni
 * falta que le hace: solo envía `{skill, promptContext}`.
 *
 * Fase 4, Paso 5: la construcción del prompt se extrajo a
 * server/gemini-prompt-builder.js (una responsabilidad, un archivo — misma
 * disciplina que ya rige el resto del proyecto), y este archivo gana una
 * segunda capa de defensa que el prompt por sí solo no puede garantizar:
 * `validateGroundedSkuUsage()`/`validateAvailabilityConsistency()`,
 * ejecutadas DESPUÉS de recibir la respuesta del modelo, antes de
 * devolverla al cliente. Ver el comentario de cabecera de
 * gemini-prompt-builder.js para el porqué completo.
 */
'use strict';

const http = require('http');
const { buildPrompt, SKILL_SCHEMAS } = require('./gemini-prompt-builder.js');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Gemini 2.0 Flash fue apagado por Google el 1 de junio de 2026.
// Mantener aquí un modelo vigente evita que un despliegue sin GEMINI_MODEL
// configurado degrade silenciosamente todas las solicitudes al fallback local.
const DEFAULT_MODEL = 'gemini-3.5-flash';
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 15000;
const COPILOT_PATH = '/copilot';

/**
 * Segunda capa de defensa (Fase 4, Paso 5) para "Mejor alternativa" y
 * "Venta cruzada": el prompt ya le pide al modelo que solo elija entre los
 * candidatos que PromptContextBuilder ya filtró según la política R-PIG-04
 * (excluir confianza Baja) — pero una instrucción de prompt no es una
 * garantía. Aquí se verifica, después del hecho, que cualquier SKU que el
 * modelo devuelva realmente pertenezca a esos candidatos ya enviados. Si
 * no, se trata como un incumplimiento del contrato — lo mismo que un
 * `skill` que no coincide — y dispara el fallback automático a Local en
 * RemoteResponseProvider.
 */
function validateGroundedSkuUsage(skill, promptContext, parsed) {
  if (skill === 'best-alternative' && parsed.encontrado && parsed.alternativa) {
    const allowed = new Set((promptContext && promptContext.alternatives || []).map(a => a.sku));
    if (!allowed.has(parsed.alternativa.sku)) {
      throw new Error('Gemini API: el modelo devolvió una alternativa cuyo sku no está entre los candidatos provistos (alternatives).');
    }
  }
  if (skill === 'cross-sell' && Array.isArray(parsed.recomendaciones)) {
    const allowed = new Set((promptContext && promptContext.crossSell || []).map(c => c.sku));
    const invalido = parsed.recomendaciones.some(r => !allowed.has(r.sku));
    if (invalido) {
      throw new Error('Gemini API: el modelo devolvió al menos una recomendación cuyo sku no está entre los candidatos provistos (crossSell).');
    }
  }
}

/**
 * Segunda capa de defensa (Fase 4, Paso 5) para "Precio y disponibilidad":
 * si el PromptContext ya declara que no hay cobertura comercial
 * (`commercialContext.disponibilidad === false`), el modelo no puede
 * reportar disponibilidad de todas formas — sería fabricar exactamente el
 * tipo de dato (precio/stock) que este proyecto nunca ha permitido inventar
 * en ninguna de las cinco habilidades.
 */
function validateAvailabilityConsistency(skill, promptContext, parsed) {
  if (skill !== 'price-availability') return;
  const comercial = promptContext && promptContext.commercialContext;
  if (comercial && comercial.disponibilidad === false && parsed.disponible !== false) {
    throw new Error('Gemini API: el modelo reportó disponibilidad cuando el PromptContext indicaba que no hay cobertura comercial.');
  }
}

/**
 * Llama a la API real de Gemini (generateContent) y normaliza la
 * respuesta a la forma del contrato de response-provider.js. `fetchImpl` es
 * inyectable a propósito — en producción es el `fetch` global de Node; en
 * QA es un mock que nunca toca la red real (ver scripts/verify-gemini-
 * proxy-server.js).
 */
async function callGemini({ skill, promptContext, apiKey, model, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let httpResponse;
  try {
    const url = `${GEMINI_API_BASE}/${model}:generateContent`;
    try {
      httpResponse = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildPrompt(skill, promptContext) }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Gemini API: tiempo de espera agotado (${timeoutMs}ms).`);
      }
      throw new Error(`Gemini API: fallo de red — ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!httpResponse.ok) {
    const errText = await httpResponse.text().catch(() => '');
    throw new Error(`Gemini API respondió ${httpResponse.status}: ${errText.slice(0, 300)}`);
  }

  const body = await httpResponse.json();
  const text = body
    && body.candidates && body.candidates[0]
    && body.candidates[0].content && body.candidates[0].content.parts
    && body.candidates[0].content.parts[0] && body.candidates[0].content.parts[0].text;
  if (typeof text !== 'string' || !text) {
    throw new Error('Gemini API: la respuesta no trae texto en candidates[0].content.parts[0].text.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini API: la respuesta del modelo no es JSON válido — ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.skill !== skill) {
    throw new Error('Gemini API: la respuesta del modelo no cumple la forma esperada del contrato (skill no coincide).');
  }
  validateGroundedSkuUsage(skill, promptContext, parsed);
  validateAvailabilityConsistency(skill, promptContext, parsed);

  // source/generatedAt los fija este servidor, no el modelo — la misma
  // disciplina que ya aplica LocalResponseProvider: metadata del sistema,
  // no algo que se le confía a la fuente de contenido.
  return { ...parsed, source: 'gemini', generatedAt: new Date().toISOString() };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function isOriginAllowed(origin, allowedOrigin) {
  if (!origin) return false;
  if (allowedOrigin) return origin === allowedOrigin;
  // Sin ALLOWED_ORIGIN explícito: solo desarrollo local. Un despliegue real
  // DEBE definir ALLOWED_ORIGIN — ver cabecera del archivo.
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function createRequestHandler({ apiKey, model, timeoutMs, allowedOrigin, fetchImpl, expectedPath = COPILOT_PATH }) {
  return async function handleRequest(req, res) {
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowedOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // `expectedPath` (opcional, default COPILOT_PATH) hace que este mismo
    // handler sirva tanto al servidor local (donde SÍ hace falta distinguir
    // /copilot de cualquier otra ruta, porque http.createServer() recibe
    // TODAS las rutas del proceso) como a un entorno serverless — Vercel,
    // por ejemplo — donde el enrutamiento de la plataforma ya garantiza que
    // solo las peticiones a la función correcta llegan aquí, así que exigir
    // una ruta interna exacta sería redundante. Pasar `expectedPath: null`
    // (ver api/copilot.js) desactiva ese chequeo y solo exige POST.
    // Retrocompatible: ningún llamador existente (startServer(), la suite de
    // QA) pasa `expectedPath`, así que conservan el chequeo `/copilot` exacto
    // de siempre, sin cambio de comportamiento.
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (expectedPath !== null) {
      const url = (req.url || '').split('?')[0];
      if (url !== expectedPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
    }

    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY no está configurada en el servidor.' }));
      return;
    }

    let payload;
    try {
      const raw = await readRequestBody(req);
      payload = JSON.parse(raw || '{}');
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cuerpo JSON inválido' }));
      return;
    }

    const { skill, promptContext } = payload || {};
    if (!skill || !SKILL_SCHEMAS[skill]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `skill desconocido: ${skill}` }));
      return;
    }

    try {
      const result = await callGemini({ skill, promptContext, apiKey, model, timeoutMs, fetchImpl });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

function startServer(options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.GEMINI_API_KEY;
  const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const port = options.port !== undefined ? options.port : (Number(process.env.PORT) || DEFAULT_PORT);
  const timeoutMs = options.timeoutMs || Number(process.env.GEMINI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const allowedOrigin = options.allowedOrigin !== undefined ? options.allowedOrigin : process.env.ALLOWED_ORIGIN;
  const fetchImpl = options.fetchImpl || fetch;

  const server = http.createServer(createRequestHandler({ apiKey, model, timeoutMs, allowedOrigin, fetchImpl }));
  return new Promise(resolve => {
    server.listen(port, () => {
      if (!options.silent) {
        console.log(`Gemini proxy escuchando en http://localhost:${server.address().port}${COPILOT_PATH}`);
        if (!apiKey) console.warn('ADVERTENCIA: GEMINI_API_KEY no está configurada — toda petición real devolverá 500.');
      }
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  createRequestHandler,
  callGemini,
  buildPrompt,
  isOriginAllowed,
  validateGroundedSkuUsage,
  validateAvailabilityConsistency,
  SKILL_SCHEMAS,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  COPILOT_PATH,
};
