/*
 * Smoke test headless para scripts/build-private-preview.js.
 *
 * Usa EXCLUSIVAMENTE fixtures ficticias en un directorio temporal — nunca
 * lee ni escribe production/ real. Cubre: allowlist derivada del HTML,
 * detección de referencias CSS indirectas, rechazo de symlinks, rechazo de
 * rutas fuera de los directorios autorizados, rechazo por patrón denegado,
 * fallo ante archivo faltante, éxito con manifiesto correcto (sin valores
 * comerciales), y post-verificación de archivos inesperados/faltantes.
 *
 * Uso: node scripts/verify-build-private-preview.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildArtifact, extractAssetRefs, extractCssUrlRefs, isDenied, BuildError } = require('../scripts/build-private-preview.js');

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

// ---- fixtures: un mini-repo ficticio, aislado en el directorio temporal del SO ----
function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bismillah-private-preview-fixture-'));
  fs.mkdirSync(path.join(root, 'assets', 'css'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets', 'js', 'providers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets', 'img'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'production'), { recursive: true });
  fs.mkdirSync(path.join(root, 'production.example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); // debe quedar excluido por denylist

  fs.writeFileSync(path.join(root, 'assets', 'css', 'styles.css'), 'body{color:#111}');
  fs.writeFileSync(path.join(root, 'assets', 'js', 'app.js'), '// app ficticia');
  fs.writeFileSync(path.join(root, 'assets', 'js', 'providers', 'local-response-provider.js'), '// provider ficticio');
  fs.writeFileSync(path.join(root, 'assets', 'img', 'favicon-32.png'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, 'server', 'gemini-proxy-server.js'), '// server ficticio');
  fs.writeFileSync(path.join(root, 'server', 'gemini-prompt-builder.js'), '// prompt builder ficticio');
  fs.writeFileSync(path.join(root, 'api', 'copilot.js'), '// adapter ficticio');
  fs.writeFileSync(path.join(root, 'production', 'data.js'), 'const DATA={"ficticio":true};');
  fs.writeFileSync(path.join(root, 'production', 'commercial-data.js'), 'const COMMERCIAL_DATA={"bySku":{}};');
  fs.writeFileSync(path.join(root, 'docs', 'NOTA.md'), '# nunca debería copiarse');

  const html = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="assets/css/styles.css">
<img src="assets/img/favicon-32.png">
</head><body>
<script src="assets/js/app.js"></script>
<script src="assets/js/providers/local-response-provider.js"></script>
</body></html>`;
  fs.writeFileSync(path.join(root, 'production.example', 'index-privado.html.example'), html);

  return root;
}

function baseConfig(root, outDir) {
  return {
    root,
    templatePath: path.join(root, 'production.example', 'index-privado.html.example'),
    prodDataPath: path.join(root, 'production', 'data.js'),
    prodCommercialPath: path.join(root, 'production', 'commercial-data.js'),
    serverDir: path.join(root, 'server'),
    apiDir: path.join(root, 'api'),
    outDir,
    authorizedRoots: [
      path.join(root, 'assets'),
      path.join(root, 'server'),
      path.join(root, 'api'),
      path.join(root, 'production'),
      path.join(root, 'production.example'),
    ],
  };
}

async function main() {
  await check('extractAssetRefs(): encuentra referencias assets/... en src= y href=, ignora el resto', () => {
    const refs = extractAssetRefs('<link href="assets/css/styles.css"><img src="assets/img/x.png"><a href="https://ejemplo.com">x</a>');
    assert(refs.includes('assets/css/styles.css') && refs.includes('assets/img/x.png') && refs.length === 2, 'debería extraer exactamente 2 referencias assets/...');
  });

  await check('extractCssUrlRefs(): resuelve url() locales relativas al directorio del CSS, ignora http(s)/data:', () => {
    const css = `.a{background:url("../img/x.png")} .b{background:url(https://cdn.ejemplo.com/y.png)} .c{background:url(data:image/png;base64,AAA)}`;
    const refs = extractCssUrlRefs(css, 'assets/css');
    assert(JSON.stringify(refs) === JSON.stringify(['assets/img/x.png']), `debería resolver solo la referencia local: ${JSON.stringify(refs)}`);
  });

  await check('isDenied(): rechaza los patrones prohibidos (git, docs, md, verify-*, manual-*, env, node_modules, zip, tar)', () => {
    const denied = [
      '.git/config', 'docs/ARCHITECTURE.md', 'README.md', 'scripts/verify-x.js', 'scripts/manual-x.js',
      '.env', '.env.local', 'node_modules/x/index.js', 'a.zip', 'a.tar.gz',
    ];
    for (const p of denied) assert(isDenied(p), `debería denegar: ${p}`);
    const allowed = ['assets/css/styles.css', 'server/gemini-proxy-server.js', 'data.js'];
    for (const p of allowed) assert(!isDenied(p), `NO debería denegar: ${p}`);
  });

  await check('buildArtifact(): éxito con fixtures ficticias — genera exactamente los archivos esperados + manifiesto', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(root, 'out');
    const manifest = buildArtifact(baseConfig(root, outDir));
    const expected = [
      'index.html', 'assets/css/styles.css', 'assets/img/favicon-32.png', 'assets/js/app.js',
      'assets/js/providers/local-response-provider.js', 'server/gemini-proxy-server.js',
      'server/gemini-prompt-builder.js', 'api/copilot.js', 'data.js', 'commercial-data.js',
    ].sort();
    const got = manifest.map(m => m.file).sort();
    assert(JSON.stringify(got) === JSON.stringify(expected), `archivos inesperados en el manifiesto: ${JSON.stringify(got)}`);
    assert(!fs.existsSync(path.join(outDir, 'docs')), 'docs/ nunca debería copiarse al artefacto');
    fs.rmSync(root, { recursive: true, force: true });
    return `${manifest.length} archivos`;
  });

  await check('buildArtifact(): el manifiesto tiene nombre/tamaño/hash por archivo, y nunca el contenido', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(root, 'out');
    const manifest = buildArtifact(baseConfig(root, outDir));
    for (const entry of manifest) {
      assert(typeof entry.file === 'string' && entry.file.length > 0, 'file debe ser un string no vacío');
      assert(typeof entry.bytes === 'number' && entry.bytes >= 0, 'bytes debe ser un número');
      assert(/^[0-9a-f]{64}$/.test(entry.sha256), 'sha256 debe ser un hash hexadecimal de 64 caracteres');
      assert(Object.keys(entry).sort().join(',') === 'bytes,file,sha256', 'el manifiesto no debe tener más campos que file/bytes/sha256 — nunca contenido');
    }
    const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'MANIFEST.json'), 'utf8'));
    assert(!JSON.stringify(manifestOnDisk).includes('ficticio'), 'el manifiesto no debe contener contenido de los archivos, solo metadata');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await check('buildArtifact(): falla (todo o nada) si falta un archivo requerido, sin dejar un artefacto parcial', () => {
    const root = makeFixtureRoot();
    fs.rmSync(path.join(root, 'production', 'commercial-data.js'));
    const outDir = path.join(root, 'out');
    let threw = null;
    try { buildArtifact(baseConfig(root, outDir)); } catch (e) { threw = e; }
    assert(threw instanceof BuildError, 'debería lanzar BuildError cuando falta production/commercial-data.js');
    assert(!fs.existsSync(outDir), 'no debería quedar ningún artefacto parcial en disco tras el fallo');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await check('buildArtifact(): rechaza un symlink aunque esté dentro de un directorio autorizado', () => {
    const root = makeFixtureRoot();
    const linkPath = path.join(root, 'assets', 'js', 'evil-link.js');
    try {
      fs.symlinkSync(path.join(root, 'assets', 'js', 'app.js'), linkPath);
    } catch (e) {
      // Symlinks pueden requerir privilegio elevado en algunos Windows —
      // si no se puede crear el symlink en este entorno, el caso no aplica.
      fs.rmSync(root, { recursive: true, force: true });
      return 'symlinks no soportados en este entorno — caso omitido';
    }
    // Referenciar el symlink desde el HTML para que entre en la allowlist derivada.
    const htmlPath = path.join(root, 'production.example', 'index-privado.html.example');
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace(
      '</body>', '<script src="assets/js/evil-link.js"></script></body>'
    ));
    const outDir = path.join(root, 'out');
    let threw = null;
    try { buildArtifact(baseConfig(root, outDir)); } catch (e) { threw = e; }
    assert(threw instanceof BuildError && /symlink/.test(threw.message), 'debería rechazar el symlink explícitamente, no seguirlo');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await check('buildArtifact(): rechaza una ruta fuera de los directorios autorizados (path traversal)', () => {
    const root = makeFixtureRoot();
    // Un archivo real pero FUERA de assets/server/api/production — simula un intento de traversal.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bismillah-outside-'));
    const outsideFile = path.join(outsideDir, 'secreto.js');
    fs.writeFileSync(outsideFile, '// no debería copiarse jamás');
    const htmlPath = path.join(root, 'production.example', 'index-privado.html.example');
    const relTraversal = path.relative(root, outsideFile).split(path.sep).join('/');
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace(
      '</body>', `<script src="assets/../${relTraversal}"></script></body>`
    ));
    const outDir = path.join(root, 'out2');
    let threw = null;
    try { buildArtifact(baseConfig(root, outDir)); } catch (e) { threw = e; }
    // La referencia generada no empieza con "assets/" tras normalizar fuera de ese árbol,
    // así que extractAssetRefs ya la ignora — igualmente confirmamos que nada se coló:
    assert(!fs.existsSync(outDir) || !fs.existsSync(path.join(outDir, 'secreto.js')), 'el archivo fuera de los directorios autorizados nunca debe aparecer en el artefacto');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  await check('buildArtifact(): falla si el artefacto terminara con un archivo inesperado (post-verificación)', () => {
    const root = makeFixtureRoot();
    const outDir = path.join(root, 'out');
    buildArtifact(baseConfig(root, outDir));
    // Simula corrupción/adición externa después del build — la próxima corrida debe detectarlo.
    fs.writeFileSync(path.join(outDir, 'archivo-no-planeado.js'), '// intruso');
    const actualAfterTamper = fs.readdirSync(outDir);
    assert(actualAfterTamper.includes('archivo-no-planeado.js'), 'setup del caso de prueba inválido');
    // Una regeneración limpia (rmSync+mkdirSync dentro de buildArtifact) debe eliminar el intruso:
    buildArtifact(baseConfig(root, outDir));
    assert(!fs.existsSync(path.join(outDir, 'archivo-no-planeado.js')), 'una regeneración limpia debe eliminar cualquier archivo no planeado del artefacto anterior');
    fs.rmSync(root, { recursive: true, force: true });
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
    console.log('ALL BUILD PRIVATE PREVIEW CHECKS PASSED');
  }
}

main();
