/* Bismillah Product Intelligence Platform — Vercel Serverless Adapter (api/copilot.js)
 *
 * Fase 6, Paso 1: adaptador delgado que expone server/gemini-proxy-server.js
 * como una función serverless de Vercel, en `/api/copilot`. No reimplementa
 * NADA — reutiliza `createRequestHandler()` tal cual, la misma pieza que ya
 * usa el servidor local (`node server/gemini-proxy-server.js`) y que ya está
 * cubierta por scripts/verify-gemini-proxy-server.js. Transporte,
 * validación de grounding, timeout, manejo de errores y la forma exacta de
 * la respuesta son, byte a byte, el mismo código en ambos entornos.
 *
 * Por qué `expectedPath: null`: Vercel ya solo invoca este archivo para
 * peticiones a `/api/copilot` — su propio enrutamiento es la garantía de
 * ruta, así que el chequeo interno de ruta exacta de
 * `createRequestHandler()` (necesario en el servidor local, donde un único
 * proceso HTTP recibe todas las rutas) sería redundante aquí. Ver el
 * comentario junto a `expectedPath` en server/gemini-proxy-server.js.
 *
 * Variables de entorno leídas (todas en runtime de Vercel, nunca hardcodeadas):
 *   GEMINI_API_KEY     — obligatoria para responder con éxito (ya configurada
 *                         como variable Sensitive en Vercel Production). Sin
 *                         ella, cada petición real responde 500 — mismo
 *                         comportamiento ya validado en el servidor local.
 *   GEMINI_MODEL        — opcional; si no está definida, usa DEFAULT_MODEL
 *                         (el mismo modelo ya vigente en todo el proyecto,
 *                         sin cambios ni nuevas versiones hardcodeadas aquí).
 *   GEMINI_TIMEOUT_MS   — opcional; si no está definida, usa DEFAULT_TIMEOUT_MS.
 *   ALLOWED_ORIGIN       — opcional. En este despliegue, frontend y función
 *                         conviven en el mismo origen de Vercel
 *                         (REMOTE_PROVIDER_CONFIG.endpoint = "/api/copilot",
 *                         same-origin) — el navegador no exige la cabecera
 *                         Access-Control-Allow-Origin para peticiones
 *                         same-origin, así que esta variable no es
 *                         necesaria para que esto funcione. Queda disponible
 *                         solo por si en el futuro algún origen externo
 *                         (otro dominio) necesitara consumir este endpoint.
 *
 * La API key nunca se acepta desde la petición del cliente, nunca se
 * registra en logs ni se refleja en ninguna respuesta — mismas garantías ya
 * verificadas en scripts/verify-gemini-proxy-server.js para el servidor
 * local, heredadas aquí sin ningún cambio porque es literalmente el mismo
 * `createRequestHandler()`.
 */
'use strict';

const { createRequestHandler, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } = require('../server/gemini-proxy-server.js');

module.exports = createRequestHandler({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
  timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  allowedOrigin: process.env.ALLOWED_ORIGIN,
  fetchImpl: fetch,
  expectedPath: null,
});
