#!/usr/bin/env node
/*
 * Bismillah Product Intelligence Platform — Private Preview Artifact Builder
 *
 * Construye, FUERA de Git, el artefacto para el perfil privado con datos
 * comerciales reales: la plantilla `production.example/index-privado.html.example`
 * (renombrada a index.html), cada asset que esa plantilla referencia
 * (allowlist DERIVADA automáticamente, no hardcodeada a mano), el servidor
 * proxy compartido y su adaptador de Vercel, y — el único paso que toca datos
 * reales — una copia de `production/data.js` y `production/commercial-data.js`.
 *
 * Este script en sí mismo NUNCA contiene, imprime ni registra ningún valor
 * comercial o de catálogo real — solo copia bytes de archivo a archivo y
 * calcula metadata (nombre/tamaño/hash). Los datos reales, si existen,
 * siguen viviendo únicamente en `production/`, gitignored, igual que antes.
 *
 * Todo o nada: se valida el plan completo (existencia, symlinks, límites de
 * directorio, patrones denegados) ANTES de escribir un solo byte. Tras
 * escribir, se re-verifica que la salida no tenga referencias rotas ni
 * archivos inesperados/faltantes.
 *
 * La lógica está parametrizada (buildArtifact) para poder probarse con
 * fixtures ficticias en scripts/verify-build-private-preview.js, sin tocar
 * nunca production/ real desde la suite automática. El bloque `main()` de
 * abajo es solo el envoltorio CLI con las rutas reales de este repositorio.
 *
 * Uso: node scripts/build-private-preview.js [--out <directorio>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Patrones que NUNCA deben entrar al artefacto — verificados activamente,
// no solo "ausentes de la allowlist".
const DENY_PATTERNS = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])docs([\\/]|$)/,
  /\.md$/i,
  /(^|[\\/])scripts[\\/]manual-/,
  /(^|[\\/])scripts[\\/]verify-/,
  /\.patch$/i,
  /\.diff$/i,
  /(^|[\\/])\.env/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /\.zip$/i,
  /\.tar(\.\w+)?$/i,
];

class BuildError extends Error {}

function isDenied(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  return DENY_PATTERNS.some(re => re.test(normalized));
}

function assertAuthorizedAndSafe(absPath, root, authorizedRoots) {
  const resolved = path.resolve(absPath);
  const lst = fs.existsSync(resolved) ? fs.lstatSync(resolved) : null;
  if (!lst) throw new BuildError(`archivo requerido no encontrado: ${path.relative(root, resolved)}`);
  if (lst.isSymbolicLink()) throw new BuildError(`symlink rechazado (no se copian symlinks): ${path.relative(root, resolved)}`);
  const withinAuthorized = authorizedRoots.some(r => resolved === r || resolved.startsWith(r + path.sep));
  if (!withinAuthorized) throw new BuildError(`ruta fuera de los directorios autorizados: ${path.relative(root, resolved)}`);
  const rel = path.relative(root, resolved);
  if (isDenied(rel)) throw new BuildError(`ruta coincide con un patrón denegado, no se incluye: ${rel}`);
  return resolved;
}

function extractAssetRefs(html) {
  const refs = new Set();
  const re = /(?:src|href)=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].startsWith('assets/')) refs.add(m[1]);
  }
  return [...refs];
}

function extractCssUrlRefs(cssContent, cssRelDir) {
  const refs = new Set();
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let m;
  while ((m = re.exec(cssContent))) {
    const v = m[1];
    if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:')) continue;
    const resolved = path.posix.normalize(path.posix.join(cssRelDir, v));
    if (resolved.startsWith('assets/')) refs.add(resolved);
  }
  return [...refs];
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walk(dir, base) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const abs = path.join(dir, d.name);
    return d.isDirectory() ? walk(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  });
}

/**
 * Construye el artefacto. Lanza BuildError (nunca escribe nada parcial) si
 * cualquier validación falla. Devuelve el manifiesto en éxito.
 * @param {{root:string, templatePath:string, prodDataPath:string, prodCommercialPath:string,
 *   serverDir:string, apiDir:string, outDir:string, authorizedRoots:string[]}} config
 */
function buildArtifact(config) {
  const { root, templatePath, prodDataPath, prodCommercialPath, serverDir, apiDir, outDir, authorizedRoots } = config;

  if (!fs.existsSync(templatePath)) {
    throw new BuildError(`plantilla no encontrada: ${path.relative(root, templatePath)}`);
  }
  const html = fs.readFileSync(templatePath, 'utf8');

  const assetRefs = extractAssetRefs(html);
  if (!assetRefs.length) throw new BuildError('la plantilla no referencia ningún archivo assets/... — allowlist derivada vacía, algo está mal.');

  const extraFromCss = [];
  for (const ref of assetRefs) {
    if (ref.endsWith('.css')) {
      const cssAbs = assertAuthorizedAndSafe(path.join(root, ref), root, authorizedRoots);
      const cssContent = fs.readFileSync(cssAbs, 'utf8');
      extraFromCss.push(...extractCssUrlRefs(cssContent, path.posix.dirname(ref)));
    }
  }

  const derivedAllowlist = [...new Set([...assetRefs, ...extraFromCss])];

  const fixedList = [
    { rel: 'server/gemini-proxy-server.js', from: path.join(serverDir, 'gemini-proxy-server.js') },
    { rel: 'server/gemini-prompt-builder.js', from: path.join(serverDir, 'gemini-prompt-builder.js') },
    { rel: 'api/copilot.js', from: path.join(apiDir, 'copilot.js') },
    { rel: 'data.js', from: prodDataPath },
    { rel: 'commercial-data.js', from: prodCommercialPath },
  ];

  const plan = [
    { rel: 'index.html', from: templatePath, contentOverride: html },
    ...derivedAllowlist.map(rel => ({ rel, from: path.join(root, rel) })),
    ...fixedList,
  ];

  // --- Validar TODO antes de escribir un solo byte (todo o nada) ---
  for (const item of plan) {
    if (isDenied(item.rel)) throw new BuildError(`archivo denegado por patrón, no se incluye: ${item.rel}`);
    assertAuthorizedAndSafe(item.from, root, authorizedRoots);
  }

  // --- Escribir el artefacto ---
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = [];
  for (const item of plan) {
    const destAbs = path.join(outDir, item.rel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    const content = item.contentOverride !== undefined
      ? Buffer.from(item.contentOverride, 'utf8')
      : fs.readFileSync(item.from);
    fs.writeFileSync(destAbs, content);
    manifest.push({ file: item.rel, bytes: content.length, sha256: sha256(content) });
  }

  // --- Post-verificación: sin referencias rotas en el HTML de salida ---
  const outHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  for (const ref of extractAssetRefs(outHtml)) {
    if (!fs.existsSync(path.join(outDir, ref))) throw new BuildError(`referencia rota en el artefacto: ${ref} no existe en la salida`);
  }
  for (const rel of ['data.js', 'commercial-data.js', 'api/copilot.js']) {
    if (!fs.existsSync(path.join(outDir, rel))) throw new BuildError(`archivo esperado ausente en la salida: ${rel}`);
  }

  // --- Post-verificación: nada inesperado, nada faltante ---
  const expected = new Set(plan.map(p => p.rel));
  const actual = walk(outDir, outDir).filter(f => f !== 'MANIFEST.json');
  const unexpected = actual.filter(f => !expected.has(f));
  if (unexpected.length) throw new BuildError(`archivo(s) inesperado(s) en el artefacto: ${unexpected.join(', ')}`);
  const missing = [...expected].filter(f => !actual.includes(f));
  if (missing.length) throw new BuildError(`archivo(s) esperado(s) ausente(s) en el artefacto: ${missing.join(', ')}`);

  fs.writeFileSync(
    path.join(outDir, 'MANIFEST.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), fileCount: manifest.length, files: manifest }, null, 2)
  );

  return manifest;
}

function main() {
  const ROOT = path.join(__dirname, '..');
  const outArgIdx = process.argv.indexOf('--out');
  const outDir = outArgIdx !== -1 && process.argv[outArgIdx + 1]
    ? path.resolve(process.argv[outArgIdx + 1])
    : path.join(ROOT, 'private-preview-build');

  const config = {
    root: ROOT,
    templatePath: path.join(ROOT, 'production.example', 'index-privado.html.example'),
    prodDataPath: path.join(ROOT, 'production', 'data.js'),
    prodCommercialPath: path.join(ROOT, 'production', 'commercial-data.js'),
    serverDir: path.join(ROOT, 'server'),
    apiDir: path.join(ROOT, 'api'),
    outDir,
    authorizedRoots: [
      path.join(ROOT, 'assets'),
      path.join(ROOT, 'server'),
      path.join(ROOT, 'api'),
      path.join(ROOT, 'production'),
      path.join(ROOT, 'production.example'),
    ],
  };

  try {
    const manifest = buildArtifact(config);
    console.log(`Artefacto privado generado en ${path.relative(ROOT, outDir)}/`);
    console.log(`  ${manifest.length} archivos (allowlist derivada de la plantilla + lista fija de servidor/datasets).`);
    console.log(`  Manifiesto: MANIFEST.json (nombre/tamaño/hash — sin valores comerciales).`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildArtifact, extractAssetRefs, extractCssUrlRefs, isDenied, assertAuthorizedAndSafe, sha256, BuildError };
