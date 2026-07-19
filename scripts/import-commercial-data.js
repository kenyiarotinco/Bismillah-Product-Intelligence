/*
 * Importa datos comerciales reales (precio, stock, estado) desde el
 * archivo ya generado por el pipeline comercial externo (Excel -> JSON,
 * fuera de este repositorio) y los deja listos, cruzados por SKU, para que
 * CommercialDataProvider (assets/js/commercial-data-provider.js) los sirva
 * a Context Builder.
 *
 * Este script NO toca ni reemplaza ese pipeline externo — solo LEE su
 * archivo de salida ya generado (un `window.BISMILLAH_DATA = {...}` embebido
 * en un .js) y produce `production/commercial-data.js`: un archivo
 * GITIGNORED (vive dentro de /production/, ya excluido por completo — ver
 * .gitignore) con la información comercial reducida al shape mínimo que
 * este proyecto necesita:
 *
 *   window.COMMERCIAL_DATA = {
 *     meta: { generatedAt, sourceRowCount, skusSinCode, coverage? },
 *     bySku: { "<sku>": { precio, stock, estado, priceDifference }, ... },
 *   };
 *
 * `priceDifference` es la diferencia entre precio de lista y precio final
 * de esa fuente — NO es margen de utilidad (no hay dato de costo en la
 * fuente). Se nombra deliberadamente distinto de "margen" para no inducir
 * a interpretarlo como rentabilidad — ver docs/ARCHITECTURE.md, Fase 3.
 *
 * Uso:
 *   node scripts/import-commercial-data.js <ruta-a-products.js-del-pipeline-comercial>
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'production', 'commercial-data.js');
const CATALOG = path.join(ROOT, 'production', 'data.js');

function loadBismillahData(sourcePath) {
  // El archivo fuente se autoejecuta como script de navegador
  // ("window.BISMILLAH_DATA = {...};"); se evalúa en un sandbox aislado con
  // un `window` mínimo, sin acceso a nada de este proceso ni del resto del
  // sistema de archivos.
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, { filename: path.basename(sourcePath) });
  return sandbox.window.BISMILLAH_DATA;
}

function loadCatalogSkus() {
  if (!fs.existsSync(CATALOG)) return null;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CATALOG, 'utf8'), sandbox, { filename: 'data.js' });
  // `const DATA` declarado por data.js no queda expuesto como propiedad del
  // sandbox tras runInContext (comportamiento del módulo vm de Node) — hay
  // que leerlo con una segunda evaluación dentro del mismo contexto.
  return vm.runInContext('DATA.products.map(p => String(p[0]))', sandbox, { filename: 'assert.js' });
}

function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Uso: node scripts/import-commercial-data.js <ruta-a-products.js-del-pipeline-comercial>');
    process.exit(1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`No se encontró el archivo: ${sourcePath}`);
    process.exit(1);
  }

  const raw = loadBismillahData(sourcePath);
  if (!raw || !Array.isArray(raw.products)) {
    console.error('El archivo fuente no tiene la forma esperada (window.BISMILLAH_DATA.products).');
    process.exit(1);
  }

  const bySku = {};
  let skusSinCode = 0;
  for (const p of raw.products) {
    const sku = String(p.code || '').trim();
    if (!sku) { skusSinCode++; continue; }
    bySku[sku] = {
      precio: typeof p.finalPrice === 'number' ? p.finalPrice : null,
      stock: typeof p.stockTotal === 'number' ? p.stockTotal : null,
      estado: p.stockStatus || null,
      priceDifference: typeof p.marginGap === 'number' ? p.marginGap : null,
    };
  }

  // Cruce informativo contra el catálogo real de este proyecto, si está
  // disponible localmente — solo para reportar cobertura; no bloquea la
  // generación del archivo si no está presente.
  const catalogSkus = loadCatalogSkus();
  const coverage = catalogSkus
    ? {
        totalCatalogo: catalogSkus.length,
        conDatoComercial: catalogSkus.filter(sku => bySku[sku]).length,
      }
    : undefined;

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceRowCount: raw.products.length,
      skusSinCode,
      ...(coverage ? { coverage } : {}),
    },
    bySku,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `window.COMMERCIAL_DATA = ${JSON.stringify(payload)};\n`, 'utf8');

  console.log(`Generado ${OUTPUT} con ${Object.keys(bySku).length} SKUs comerciales.`);
  if (coverage) {
    console.log(`Cobertura: ${coverage.conDatoComercial}/${coverage.totalCatalogo} productos del catálogo tienen dato comercial.`);
  } else {
    console.log('production/data.js no está presente localmente — no se calculó cobertura contra el catálogo.');
  }
}

main();
