/*
 * Smoke test headless para las SALVAGUARDAS de scripts/manual-gemini-live-
 * check.js (Fase 4, Paso 6) — no para la llamada real en sí, que por
 * diseño queda fuera de esta suite (ver docs/GEMINI_MANUAL_VALIDATION.md).
 *
 * Este script SÍ forma parte de la regresión automática porque no hace
 * ninguna llamada de red bajo ningún escenario que verifica: solo confirma
 * que manual-gemini-live-check.js se niega a arrancar sin GEMINI_API_KEY,
 * se niega a arrancar sin el flag de confirmación explícita, y rechaza un
 * skill desconocido — las tres salvaguardas que evitan que ese script
 * ejecute una llamada real y facturable por accidente. Si alguna regresión
 * futura debilitara esas salvaguardas, este script lo detectaría sin
 * necesidad de una GEMINI_API_KEY real.
 *
 * Uso: node scripts/verify-manual-gemini-check-safeguards.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'manual-gemini-live-check.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true, detail: '' });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function main() {
  check('el archivo del script existe y no referencia SDKs de otros proveedores de IA', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert(!/openai|anthropic/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'este script es específico de Gemini');
  });

  check('nunca acepta la API key como argumento de línea de comandos (ningún flag tipo --api-key/--key)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert(!/--api-key|--gemini-key|args\.apiKey/i.test(src), 'no debería existir ningún mecanismo para pasar la key por CLI');
  });

  check('sin GEMINI_API_KEY en el entorno: sale con código de error, sin hacer ninguna llamada de red, incluso con el flag de confirmación', () => {
    const res = run(['--confirmo-el-costo'], { GEMINI_API_KEY: '' });
    assert(res.status !== 0, 'debería salir con código de error');
    assert(/Falta GEMINI_API_KEY/.test(res.stderr), 'debería explicar que falta la API key');
  });

  check('con GEMINI_API_KEY pero SIN el flag --confirmo-el-costo: sale con código de error, sin hacer ninguna llamada de red', () => {
    const res = run([], { GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    assert(res.status !== 0, 'debería salir con código de error');
    assert(/confirmaci[oó]n expl[ií]cita/.test(res.stderr), 'debería explicar que falta el flag de confirmación');
  });

  check('con key y flag, pero un --skill desconocido: sale con código de error antes de intentar cualquier llamada', () => {
    const res = run(['--confirmo-el-costo', '--skill=no-existe'], { GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    assert(res.status !== 0, 'debería salir con código de error');
    assert(/Skill desconocido/.test(res.stderr), 'debería explicar que el skill no es válido');
  });

  check('el flag de confirmación exige el texto exacto --confirmo-el-costo (una variación no basta)', () => {
    const res = run(['--confirmo'], { GEMINI_API_KEY: 'clave-de-prueba-no-real' });
    assert(res.status !== 0, 'un flag parcial/distinto no debería contar como confirmación');
    assert(/confirmaci[oó]n expl[ií]cita/.test(res.stderr), 'debería seguir pidiendo la confirmación exacta');
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
    console.log('ALL MANUAL GEMINI CHECK SAFEGUARDS PASSED');
  }
}

main();
