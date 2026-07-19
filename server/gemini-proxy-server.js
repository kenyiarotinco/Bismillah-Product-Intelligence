#!/usr/bin/env node
/* Bismillah Product Intelligence Platform — Gemini Proxy Server (Fase 4, Paso 4)
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
 */
'use strict';

const http = require('http');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 15000;
const COPILOT_PATH = '/copilot';

// Mismo contrato ya documentado en response-provider.js — se repite aquí en
// forma de instrucción para el modelo, no como una nueva fuente de verdad:
// si ese contrato cambia, este mapa debe actualizarse junto con él.
const SKILL_SCHEMAS = {
  'explain-product': '{ "skill": "explain-product", "text": "<explicación en español, basada EXCLUSIVAMENTE en los datos de productKnowledge/commercialContext>" }',
  'compare-products': '{ "skill": "compare-products", "productos": { "a": {}, "b": {} }, "similitudes": ["..."], "diferencias": ["..."] }',
  'best-alternative': '{ "skill": "best-alternative", "encontrado": true, "alternativa": { "sku": "...", "nombre": "..." }, "afinidad": "Alta", "justificacion": "...", "mensaje": null }',
  'cross-sell': '{ "skill": "cross-sell", "recomendaciones": [ { "sku": "...", "nombre": "...", "razon": "..." } ], "mensaje": null }',
  'price-availability': '{ "skill": "price-availability", "disponible": true, "precio": 0, "precioLista": 0, "priceDifference": 0, "stock": 0, "estado": "...", "mensaje": null }',
};

/**
 * Arma el prompt de texto que se envía a Gemini. Es la única pieza de todo
 * el sistema que traduce un PromptContext (datos estructurados, Fase 4
 * Paso 2) a lenguaje natural para un modelo — PromptContextBuilder tiene
 * explícitamente prohibido hacer esto; aquí es exactamente lo que se
 * necesita para invocar un LLM real.
 */
function buildPrompt(skill, promptContext) {
  const schema = SKILL_SCHEMAS[skill];
  return [
    'Eres el "AI Sales Copilot" de Bismillah Product Intelligence Platform, un asistente de venta B2B para un catálogo farmacéutico/bienestar.',
    'Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto adicional antes o después) con exactamente esta forma:',
    schema,
    '',
    'Reglas estrictas:',
    '- Usa EXCLUSIVAMENTE la información que aparece en el PromptContext de abajo. Nunca inventes precios, stock, nombres de producto ni relaciones que no estén ahí.',
    '- Si un dato no está disponible en el PromptContext (por ejemplo, sin cobertura comercial), dilo honestamente en el campo correspondiente en vez de inventarlo o suponerlo.',
    '- Responde en español.',
    '',
    `Habilidad solicitada: ${skill}`,
    'PromptContext (JSON):',
    JSON.stringify(promptContext),
  ].join('\n');
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

function createRequestHandler({ apiKey, model, timeoutMs, allowedOrigin, fetchImpl }) {
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

    const url = (req.url || '').split('?')[0];
    if (req.method !== 'POST' || url !== COPILOT_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
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
  SKILL_SCHEMAS,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  COPILOT_PATH,
};
