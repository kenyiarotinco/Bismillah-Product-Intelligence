/*
 * Generates assets/js/data.js — the synthetic, safe-for-public default dataset — from
 * production/data.js (the real catalog, which is git-ignored and never committed).
 *
 * What is preserved byte-for-byte:
 *   - relationship types, audiences, subcategory taxonomy, justification texts
 *     (generic industry vocabulary: "Vitamina C", "Belleza", "Inmunidad" — not
 *     company-identifying)
 *   - the exact relationship graph (rels: src, dst, type, confidence, justification)
 *   so every KPI, distribution, degree stat and recommendation score in the demo
 *   is IDENTICAL to production.
 *
 * What is fully regenerated as fiction:
 *   - product names, SKUs and tags — the layer that actually carried real brand
 *     and manufacturer information.
 *
 * Usage: node scripts/generate-demo-data.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROD_PATH = path.join(__dirname, '..', 'production', 'data.js');
const OUT_PATH = path.join(__dirname, '..', 'assets', 'js', 'data.js');

if (!fs.existsSync(PROD_PATH)) {
  console.error('production/data.js not found — nothing to anonymize.');
  console.error('See production.example/ and README.md for how to set up the production profile locally.');
  process.exit(1);
}

// Seeded PRNG so re-running this script produces a stable, reviewable diff.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260718);
const pick = arr => arr[Math.floor(rand() * arr.length)];

const raw = fs.readFileSync(PROD_PATH, 'utf8').split('\n').slice(1).join('\n'); // drop header comment
const DATA = JSON.parse(raw.replace(/^const DATA=/, '').replace(/;\s*$/, ''));

/* ---------- entirely fictional brand vocabulary (combinatorial, no real trademarks) ---------- */
const BRAND_PREFIX = ['Vita','Nutri','Bio','Sana','Puro','Zen','Prima','Vida','Aura','Flor','Andi','Suma','Kalpa','Raiz','Terra','Solis','Luma','Nova','Equi','Mira'];
const BRAND_SUFFIX = ['lyx','via','core','flex','plena','tal','mia','ande','sol','ra','bien','vital','max','pro','herbal','labs','well','andina','forte','activa'];
const BRANDS = [...new Set(BRAND_PREFIX.flatMap(p => BRAND_SUFFIX.map(s => p + s)))];

const VARIANT_WORDS = ['Forte','Plus','Max','Advance','Gold','Active','Pure','Balance','Vital','Complex','Renew','Total','Rapid','Extra','Premium'];
const PACKAGE = [['FCO','GR'], ['CJA','CAP'], ['CJA','TAB'], ['FCO','ML'], ['SOBRES','UNID'], ['CJA','COMP']];
const QTY = [10,15,20,24,30,50,60,90,100,120,150,200,250,300,315,330,400,500,700];
const GENERIC_TAGS = ['suplemento','bienestar','calidad premium','uso diario','natural','formula avanzada'];

function topicFromSubcat(sc) {
  if (!sc) return 'Bienestar';
  return sc.replace(/^[BF]\d+\.\d+\s*/, '').split(/[\s(,/]/)[0];
}

/* ---------- assign one shared brand per VARIANTE-connected component ---------- */
/* (VARIANTE = same underlying product in a different flavor/size — should share a brand) */
const N = DATA.products.length;
const parent = Array.from({length: N}, (_, i) => i);
function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
const VARIANTE_TYPE = DATA.types.indexOf('VARIANTE');
for (const [a, b, t] of DATA.rels) if (t === VARIANTE_TYPE) union(a, b);

const brandByRoot = new Map();
function brandFor(i) {
  const root = find(i);
  if (!brandByRoot.has(root)) brandByRoot.set(root, pick(BRANDS));
  return brandByRoot.get(root);
}

/* ---------- generate fictional products ---------- */
const usedSkus = new Set();
function genSku() {
  let s;
  do { s = 30000 + Math.floor(rand() * 30000); } while (usedSkus.has(s));
  usedSkus.add(s);
  return s;
}

const usedNames = new Set();
function genName(topic, brand) {
  const variant = pick(VARIANT_WORDS);
  const [container, unit] = pick(PACKAGE);
  const qty = pick(QTY);
  let name = `${topic.toUpperCase()} ${brand.toUpperCase()} ${variant.toUpperCase()} ${container} X ${qty} ${unit}.`;
  let tries = 0;
  while (usedNames.has(name) && tries < 30) {
    tries++;
    name = `${topic.toUpperCase()} ${brand.toUpperCase()} ${variant.toUpperCase()} ${container} X ${pick(QTY)} ${unit}. V${tries + 1}`;
  }
  usedNames.add(name);
  return name;
}

function genTags(topic, brand) {
  const out = new Set([topic.toLowerCase(), brand.toLowerCase(), pick(GENERIC_TAGS)]);
  while (out.size < 4) out.add(pick(GENERIC_TAGS));
  return [...out].join(', ');
}

const products = DATA.products.map((p, i) => {
  const [, , subcatIdx, , , auds] = p;
  const topic = topicFromSubcat(subcatIdx >= 0 ? DATA.subcats[subcatIdx] : null);
  const brand = brandFor(i);
  const name = genName(topic, brand);
  const sku = genSku();
  const tags = genTags(topic, brand);
  return [sku, name, subcatIdx, 0, tags, auds];
});

// Recompute degree from the (unchanged) relationship graph — guaranteed consistent.
const deg = new Array(N).fill(0);
for (const [a, b] of DATA.rels) { deg[a]++; deg[b]++; }
products.forEach((p, i) => { p[3] = deg[i]; });

const OUT = {
  types: DATA.types,
  auds: DATA.auds,
  subcats: DATA.subcats,
  products,
  justs: DATA.justs,
  rels: DATA.rels,
};

const header = '/* Bismillah Product Intelligence Platform — SYNTHETIC demo dataset. ' +
  'Fictional products/brands/SKUs; graph topology matches production so all KPIs and ' +
  'behaviors are identical. Generated by scripts/generate-demo-data.js — do not hand-edit. */\n';
fs.writeFileSync(OUT_PATH, header + 'const DATA=' + JSON.stringify(OUT) + ';\n');

console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${products.length} fictional products, ${DATA.rels.length} relations (topology unchanged from production).`);
