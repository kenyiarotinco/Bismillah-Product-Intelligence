#!/usr/bin/env node
/*
 * Verificación MANUAL contra la API REAL de Gemini (Fase 4, Paso 6).
 *
 * Este script NO es parte de la suite automática (scripts/verify-*.js) ni
 * de la regresión — esa sigue siendo, a propósito, 100% simulada (ver
 * Fase 4, Pasos 4 y 5). Este archivo existe para que un humano, con su
 * propia GEMINI_API_KEY real, pueda confirmar con sus propios ojos que la
 * integración completa (RemoteResponseProvider → gemini-proxy-server →
 * Gemini real) funciona de punta a punta — deliberadamente FUERA del flujo
 * automático, para que nunca se ejecute por accidente ni tenga costo
 * oculto en ningún CI/regresión.
 *
 * Salvaguardas explícitas, ambas obligatorias:
 *   1. GEMINI_API_KEY debe venir del entorno — este script NUNCA la acepta
 *      como argumento de línea de comandos (quedaría en el historial de la
 *      shell).
 *   2. El flag --confirmo-el-costo es obligatorio. Sin él, el script no
 *      hace ninguna llamada de red — solo imprime el modo de uso.
 *
 * Uso:
 *   GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js --confirmo-el-costo [--skill=explain-product] [--producto=0]
 *
 * Ver docs/GEMINI_MANUAL_VALIDATION.md para la guía completa paso a paso,
 * incluyendo qué revisar en la salida y qué hacer si algo falla.
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../server/gemini-proxy-server.js');

const ROOT = path.join(__dirname, '..');
const CONFIRM_FLAG = '--confirmo-el-costo';
const VALID_SKILLS = ['explain-product', 'compare-products', 'best-alternative', 'cross-sell', 'price-availability'];
const METHOD_BY_SKILL = {
  'explain-product': 'explainProduct',
  'compare-products': 'compareProducts',
  'best-alternative': 'bestAlternative',
  'cross-sell': 'crossSell',
  'price-availability': 'priceAndAvailability',
};

function parseArgs(argv) {
  const args = { skill: 'explain-product', producto: '0', confirm: false };
  for (const raw of argv) {
    if (raw === CONFIRM_FLAG) args.confirm = true;
    else if (raw.startsWith('--skill=')) args.skill = raw.slice('--skill='.length);
    else if (raw.startsWith('--producto=')) args.producto = raw.slice('--producto='.length);
  }
  return args;
}

function printUsage() {
  console.error(`Uso: GEMINI_API_KEY=<tu-key> node scripts/manual-gemini-live-check.js ${CONFIRM_FLAG} [--skill=explain-product] [--producto=0]`);
  console.error(`Skills válidos: ${VALID_SKILLS.join(', ')}`);
}

// Carga el mismo cliente que corre en el navegador (RemoteResponseProvider y
// todo lo que necesita) en un sandbox de Node — mismo mecanismo ya usado por
// scripts/verify-remote-response-provider.js y scripts/verify-gemini-proxy-
// server.js, pero aquí con el `fetch` REAL de Node en TODOS los tramos (sin
// ningún mock): cliente → proxy real → Gemini real.
function loadClientSandbox(remoteEndpoint) {
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
  const sandbox = {};
  vm.createContext(sandbox);
  sandbox.fetch = fetch;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.AbortController = AbortController;
  // Este flag SOLO existe dentro de este sandbox de Node, para esta
  // ejecución manual — nunca se escribe en ningún archivo del repositorio
  // ni en ningún perfil (index.html sigue sin definir FEATURE_FLAGS).
  vm.runInContext('var FEATURE_FLAGS = { remoteResponseProvider: true };', sandbox);
  vm.runInContext(`var REMOTE_PROVIDER_CONFIG = { endpoint: ${JSON.stringify(remoteEndpoint)}, timeoutMs: 20000 };`, sandbox);
  for (const key of ['data', 'contextBuilder', 'promptContextBuilder', 'commercialDataProvider', 'featureFlags', 'responseProviderContract', 'responseProvider', 'localProvider', 'remoteProvider']) {
    vm.runInContext(fs.readFileSync(FILES[key], 'utf8'), sandbox, { filename: path.basename(FILES[key]) });
  }
  return sandbox;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.GEMINI_API_KEY) {
    console.error('✗ Falta GEMINI_API_KEY en el entorno.');
    printUsage();
    process.exit(1);
  }
  if (!args.confirm) {
    console.error(`✗ Falta el flag de confirmación explícita ${CONFIRM_FLAG}.`);
    console.error('  Este script hace AL MENOS UNA llamada real y facturable a la API de Gemini — no se ejecuta por accidente.');
    printUsage();
    process.exit(1);
  }
  if (!VALID_SKILLS.includes(args.skill)) {
    console.error(`✗ Skill desconocido: "${args.skill}".`);
    printUsage();
    process.exit(1);
  }

  console.log('⚠ Este script va a realizar una llamada REAL y FACTURABLE a la API de Gemini.');
  console.log(`  Habilidad: ${args.skill} · Producto de referencia: ${args.producto}\n`);

  const server = await startServer({ apiKey: process.env.GEMINI_API_KEY, port: 0, fetchImpl: fetch, silent: true });
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/copilot`;
    const sandbox = loadClientSandbox(endpoint);
    const run = code => vm.runInContext(code, sandbox, { filename: 'manual-check.js' });

    // Paso 1/2 — llamada HTTP directa al proxy (sin pasar por
    // RemoteResponseProvider), para ver el HTTP status y el cuerpo exactos
    // que devolvió el proxy, incluso si termina siendo un error — el
    // fallback de RemoteResponseProvider en el paso 2 oculta ese detalle a
    // propósito (ver assets/js/providers/remote-response-provider.js), así
    // que este primer paso es el único lugar donde se ve la causa real.
    const rawPayloadJson = run(`
      (function () {
        ${args.skill === 'compare-products'
        ? `const ctxA = ContextBuilder.build(${JSON.stringify(/^\d+$/.test(args.producto) ? Number(args.producto) : args.producto)}, { maxPerType: 300 });
           const ctxB = ContextBuilder.build(${JSON.stringify(/^\d+$/.test(args.producto) ? Number(args.producto) : args.producto)} === 0 ? 1 : 0, { maxPerType: 300 });
           if (!ctxA || !ctxB) throw new Error('Producto de referencia no encontrado en el catálogo.');
           return JSON.stringify({
             promptContext: {
               a: PromptContextBuilder.build(ctxA, { intent: { skill: 'compare-products' } }),
               b: PromptContextBuilder.build(ctxB, { intent: { skill: 'compare-products' } }),
             },
           });`
        : `const ctx = ContextBuilder.build(${JSON.stringify(/^\d+$/.test(args.producto) ? Number(args.producto) : args.producto)}, { maxPerType: 300 });
           if (!ctx) throw new Error('Producto de referencia no encontrado en el catálogo.');
           return JSON.stringify({
             promptContext: PromptContextBuilder.build(ctx, { intent: { skill: ${JSON.stringify(args.skill)} } }),
           });`}
      })()
    `);
    const { promptContext: rawPromptContext } = JSON.parse(rawPayloadJson);

    console.log('[1/2] Llamada HTTP directa al proxy (diagnóstico)...');
    const rawHttpRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: args.skill, promptContext: rawPromptContext }),
    });
    const rawBody = await rawHttpRes.json().catch(() => null);
    console.log(`      HTTP ${rawHttpRes.status}`);
    console.log('      ' + JSON.stringify(rawBody, null, 2).split('\n').join('\n      '));

    // Paso 2/2 — el camino real: RemoteResponseProvider, exactamente como lo
    // usaría la aplicación en el navegador si el flag estuviera activo.
    console.log('\n[2/2] A través de RemoteResponseProvider (camino real de la aplicación)...');
    const res = await run(`
      (async function () {
        ${args.skill === 'compare-products'
        ? `const ctxA = ContextBuilder.build(${JSON.stringify(/^\d+$/.test(args.producto) ? Number(args.producto) : args.producto)}, { maxPerType: 300 });
           const ctxB = ContextBuilder.build(${JSON.stringify(/^\d+$/.test(args.producto) ? Number(args.producto) : args.producto)} === 0 ? 1 : 0, { maxPerType: 300 });
           return RemoteResponseProvider.compareProducts(ctxA, ctxB);`
        : `const ctx = ContextBuilder.build(${JSON.stringify(/^\d+$/.test(args.producto) ? Number(args.producto) : args.producto)}, { maxPerType: 300 });
           return RemoteResponseProvider.${METHOD_BY_SKILL[args.skill]}(ctx);`}
      })()
    `);
    console.log('      ' + JSON.stringify(res, null, 2).split('\n').join('\n      '));

    console.log('');
    if (res.source === 'gemini') {
      console.log('✓ ÉXITO: la respuesta vino realmente de Gemini (source:"gemini").');
    } else {
      console.log('⚠ La respuesta cayó al fallback local (source:"local"). Revisa el HTTP status/cuerpo del paso [1/2] arriba para ver la causa exacta.');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error('✗ Error inesperado:', err.message);
  process.exit(1);
});
