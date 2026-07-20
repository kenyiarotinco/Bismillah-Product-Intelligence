/*
 * Verificación de la activación controlada del perfil ai-preview.
 * Todas las respuestas remotas se simulan en memoria: esta suite no lee
 * variables de entorno ni realiza llamadas de red.
 *
 * Uso: node scripts/verify-controlled-remote-activation.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ROOT_INDEX = path.join(ROOT, 'index.html');
const PREVIEW_INDEX = path.join(ROOT, 'ai-preview', 'index.html');
const APP_FILE = path.join(ROOT, 'assets', 'js', 'app.js');
const FRONTEND_FILES = [
  ROOT_INDEX,
  PREVIEW_INDEX,
  ...[
    'feature-flags.js',
    'response-provider-contract.js',
    'response-provider.js',
    'providers/local-response-provider.js',
    'providers/remote-response-provider.js',
    'providers/ai-response-provider.js',
    'app.js',
  ].map(file => path.join(ROOT, 'assets', 'js', file)),
];
const LOAD_ORDER = [
  'data.js',
  'context-builder.js',
  'prompt-context-builder.js',
  'commercial-data-provider.js',
  'feature-flags.js',
  'response-provider-contract.js',
  'response-provider.js',
  'providers/local-response-provider.js',
  'providers/remote-response-provider.js',
  'providers/ai-response-provider.js',
];

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function freshSandbox(fetchImpl, { featureFlags = { remoteResponseProvider: true }, remoteConfig = { endpoint: '/api/copilot' } } = {}) {
  const sandbox = { setTimeout, clearTimeout, AbortController, fetch: fetchImpl };
  vm.createContext(sandbox);
  if (featureFlags) vm.runInContext(`var FEATURE_FLAGS = ${JSON.stringify(featureFlags)};`, sandbox);
  if (remoteConfig) vm.runInContext(`var REMOTE_PROVIDER_CONFIG = ${JSON.stringify(remoteConfig)};`, sandbox);
  for (const file of LOAD_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

async function main() {
  await check('la raíz no define configuración remota y conserva el perfil local', () => {
    const root = fs.readFileSync(ROOT_INDEX, 'utf8');
    assert(!/FEATURE_FLAGS\s*=/.test(root), 'index.html no debe activar el flag remoto');
    assert(!/REMOTE_PROVIDER_CONFIG\s*=/.test(root), 'index.html no debe configurar un endpoint remoto');
    const sandbox = freshSandbox(null, { featureFlags: null, remoteConfig: null });
    vm.runInContext("ResponseProvider.use(FeatureFlags.isEnabled('remoteResponseProvider') ? AIResponseProvider : LocalResponseProvider);", sandbox);
    assert(vm.runInContext('ResponseProvider.get() === LocalResponseProvider', sandbox), 'la selección por defecto debe mantener LocalResponseProvider activo');
  });

  await check('ai-preview carga el catálogo sintético y activa AIResponseProvider mediante el flag', () => {
    const preview = fs.readFileSync(PREVIEW_INDEX, 'utf8');
    assert(/src="\.\.\/assets\/js\/data\.js"/.test(preview), 'ai-preview debe cargar el dataset sintético data.js');
    assert(/remoteResponseProvider:\s*true/.test(preview), 'ai-preview debe activar remoteResponseProvider');
    assert(/endpoint:\s*['"]\/api\/copilot['"]/.test(preview), 'ai-preview debe usar el endpoint relativo /api/copilot');
    const app = fs.readFileSync(APP_FILE, 'utf8');
    assert(/FeatureFlags\.isEnabled\('remoteResponseProvider'\)\s*\?\s*AIResponseProvider\s*:\s*LocalResponseProvider/.test(app),
      'app.js debe seleccionar AIResponseProvider solo cuando el flag esté activo');
  });

  await check('respuesta remota simulada a través de AIResponseProvider conserva source:"gemini"', async () => {
    let requestedEndpoint = null;
    const sandbox = freshSandbox((endpoint, options) => {
      requestedEndpoint = endpoint;
      const payload = JSON.parse(options.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          skill: payload.skill,
          source: 'gemini',
          generatedAt: '2026-07-19T00:00:00.000Z',
          text: 'Respuesta remota simulada.',
        }),
      });
    });
    const result = await vm.runInContext(`
      (async function () {
        const context = ContextBuilder.build(0, { maxPerType: 15 });
        ResponseProvider.use(AIResponseProvider);
        return ResponseProvider.get().explainProduct(context);
      })()
    `, sandbox);
    assert(requestedEndpoint === '/api/copilot', `se esperaba /api/copilot, se obtuvo ${requestedEndpoint}`);
    assert(result.source === 'gemini', `se esperaba source:"gemini", se obtuvo ${result.source}`);
  });

  await check('un fallo remoto simulado cae automáticamente a LocalResponseProvider', async () => {
    const sandbox = freshSandbox(() => Promise.reject(new Error('fallo remoto simulado')));
    const result = await vm.runInContext(`
      (async function () {
        const context = ContextBuilder.build(0, { maxPerType: 15 });
        ResponseProvider.use(AIResponseProvider);
        return ResponseProvider.get().explainProduct(context);
      })()
    `, sandbox);
    assert(result.source === 'local', `se esperaba source:"local", se obtuvo ${result.source}`);
  });

  await check('no hay referencias a secretos en los archivos servidos al navegador', () => {
    const offenders = FRONTEND_FILES.filter(file => /GEMINI_API_KEY/i.test(fs.readFileSync(file, 'utf8')));
    assert(offenders.length === 0, `se encontraron referencias a secretos en: ${offenders.map(file => path.relative(ROOT, file)).join(', ')}`);
  });

  const failed = results.filter(result => !result.pass);
  for (const result of results) {
    console.log(`${result.pass ? '✓' : '✗'} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks OK`);
  if (failed.length) process.exit(1);
  console.log('ALL CONTROLLED REMOTE ACTIVATION CHECKS PASSED');
}

main();
