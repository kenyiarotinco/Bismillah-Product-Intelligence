/* Bismillah Product Intelligence Platform — MVP v1.0 */
'use strict';

/* ---------- metadata ---------- */
const TYPE_META = [
  {k:'MISMA_CATEGORIA',  label:'Misma categoría',   color:'var(--t0)', hex:'#0C7C59', desc:'Comparten subcategoría estructural del Baseline'},
  {k:'MISMO_BENEFICIO',  label:'Mismo beneficio',   color:'var(--t1)', hex:'#2B7DB8', desc:'Aportan al mismo beneficio para el cliente'},
  {k:'MISMO_INGREDIENTE',label:'Mismo ingrediente', color:'var(--t2)', hex:'#7A5FBF', desc:'Comparten elemento o ingrediente base'},
  {k:'SUSTITUYE',        label:'Sustituye',         color:'var(--t3)', hex:'#BC4438', desc:'Equivalentes o alternativas de reemplazo'},
  {k:'COMPLEMENTA',      label:'Complementa',       color:'var(--t4)', hex:'#D98E2B', desc:'Sinergia nutricional o de uso conjunto'},
  {k:'MISMA_AUDIENCIA',  label:'Misma audiencia',   color:'var(--t5)', hex:'#C2557F', desc:'Dirigidos al mismo público objetivo'},
  {k:'VARIANTE',         label:'Variante',          color:'var(--t6)', hex:'#5E7A31', desc:'Sabor, tamaño o momento del mismo producto'},
];
const CONF_META = [
  {label:'Alta',  cls:'conf0'},
  {label:'Media', cls:'conf1'},
  {label:'Baja',  cls:'conf2'},
];
const FAMILY = {
  B1:'Colágenos y belleza', B2:'Magnesio', B3:'Vitaminas y minerales', B4:'Gomitas funcionales',
  B5:'Salud articular', B6:'Omegas y aceites', B7:'Botánica y superfoods', B8:'Digestivo y probióticos',
  B9:'Sueño y energía', B10:'Nutrición y endulzantes', B11:'Dermocosmética y otros',
  F1:'Dolor e inflamación', F2:'Antiinfecciosos', F3:'Gastrointestinal', F4:'Cardiometabólico',
  F5:'SNC y salud mental', F6:'Respiratorio y alergias', F7:'Salud sexual y urológica',
  F8:'Tópicos', F9:'Corticoides y hormonales', F10:'Neurotrópicos y clínicos',
};
const RISKS = [
  ['R-PIG-01','Sesgo hacia inventario alto','El top-K por valor prioriza como vecinos los productos con mayor peso comercial.','Medio','Deliberado y documentado (§4). Los motores podrán re-ponderar.'],
  ['R-PIG-02','COMPLEMENTA depende de matriz curada','8 pares nutricionales definidos por conocimiento, no por datos de venta.','Medio','Techo de confianza Media; validar con datos de venta cruzada.'],
  ['R-PIG-03','SUSTITUYE-D2 sensible al ingrediente','Nombres truncados (R-001) pueden producir sustitutos con confianza inflada.','Medio','Techo Media + top-4; revisión muestral antes de activar.'],
  ['R-PIG-04','184 aristas de confianza Baja','Heredan la confianza Baja de clasificación de alguno de sus nodos.','Bajo','Los motores deben excluir confianza Baja por defecto.'],
  ['R-PIG-05','Hubs de alta conectividad','Los colágenos top concentran hasta 229 conexiones; riesgo de sobre-exposición.','Bajo','Aplicar límites de frecuencia por producto en los motores.'],
  ['R-PIG-06','18 productos NO_CLASIFICADO fuera del grafo','Sin atributos para derivar relaciones.','Bajo','Ingreso automático al resolver su revisión manual de Etapa 3.'],
];
const CROSS_TYPE_W = {4:3.0, 1:2.0, 5:1.5, 2:1.0};   // COMPLEMENTA, MISMO_BENEFICIO, MISMA_AUDIENCIA, MISMO_INGREDIENTE
const CONF_W = [1.0, 0.6, 0.25];

/* ---------- indexes ---------- */
const P = DATA.products, R = DATA.rels, J = DATA.justs, SC = DATA.subcats;
const N = P.length;
const adj = Array.from({length:N}, () => []);
for (let i = 0; i < R.length; i++) {
  const [a, b, t, c, j] = R[i];
  adj[a].push({o:b, t, c, j});
  adj[b].push({o:a, t, c, j});
}
const famOf = P.map(p => {
  if (p[2] < 0) return null;
  const m = SC[p[2]].match(/^([BF]\d+)/);
  return m ? m[1] : null;
});
const uniOf = famOf.map(f => f ? f[0] : '?');
const skuToIdx = new Map(P.map((p, i) => [String(p[0]), i]));
const searchBlob = P.map(p => (p[0] + ' ' + p[1] + ' ' + p[4]).toLowerCase());
const famList = Object.keys(FAMILY).filter(f => famOf.includes(f))
  .sort((a, b) => (a[0] === b[0] ? parseInt(a.slice(1)) - parseInt(b.slice(1)) : a < b ? -1 : 1));

const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => n.toLocaleString('es-PE');
const $ = sel => document.querySelector(sel);

function searchProducts(q, limit = 8) {
  q = norm(q.trim());
  if (q.length < 2) return [];
  const terms = q.split(/\s+/);
  const out = [];
  for (let i = 0; i < N; i++) {
    const blob = norm(searchBlob[i]);
    if (terms.every(t => blob.includes(t))) {
      out.push(i);
      if (out.length >= 400) break;
    }
  }
  out.sort((a, b) => {
    const an = norm(P[a][1]).startsWith(q) ? 0 : 1;
    const bn = norm(P[b][1]).startsWith(q) ? 0 : 1;
    return an - bn || P[b][3] - P[a][3];
  });
  return out.slice(0, limit);
}

/* ---------- router ---------- */
const TITLES = {
  panorama: ['Panorama del grafo', 'Salud y estructura del catálogo relacionado'],
  explorador: ['Explorador de catálogo', '1.094 productos en dos universos: Bienestar y Farma'],
  p360: ['Producto 360', 'La red completa de un producto en una sola pantalla'],
  motores: ['Motores de recomendación', 'Venta cruzada, sustitución y variantes con scoring transparente'],
};
let currentView = 'panorama';
function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + name));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  $('#view-title').textContent = TITLES[name][0];
  $('#view-sub').textContent = TITLES[name][1];
  window.scrollTo({top:0});
}
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

/* ---------- global search ---------- */
const gsIn = $('#gsearch-in'), gsDrop = $('#gsearch-drop');
function gsRender() {
  const res = searchProducts(gsIn.value);
  if (!res.length) { gsDrop.classList.remove('open'); gsDrop.innerHTML = ''; return; }
  gsDrop.innerHTML = res.map(i => `
    <button class="gs-item" data-i="${i}" role="option">
      <div class="nm">${esc(P[i][1])}</div>
      <div class="mt">SKU ${P[i][0]} · ${famOf[i] ? esc(FAMILY[famOf[i]]) : '—'} · ${P[i][3]} relaciones</div>
    </button>`).join('');
  gsDrop.classList.add('open');
  gsDrop.querySelectorAll('.gs-item').forEach(el =>
    el.addEventListener('click', () => { openProduct(+el.dataset.i); gsDrop.classList.remove('open'); gsIn.value = ''; }));
}
gsIn.addEventListener('input', gsRender);
gsIn.addEventListener('focus', gsRender);
document.addEventListener('click', e => {
  if (!e.target.closest('.gsearch')) {
    gsDrop.classList.remove('open');
    const en = document.getElementById('en-drop');
    if (en) en.classList.remove('open');
  }
});

/* ================= PANORAMA ================= */
function renderPanorama() {
  const typeCount = TYPE_META.map(() => 0);
  const confCount = [0, 0, 0];
  const confByType = TYPE_META.map(() => [0, 0, 0]);
  let recip = 0;
  const pairSeen = new Map();
  for (const [a, b, t, c] of R) {
    typeCount[t]++; confCount[c]++; confByType[t][c]++;
    const kf = a + '|' + b + '|' + t, kr = b + '|' + a + '|' + t;
    if (pairSeen.has(kr)) recip += 2;
    pairSeen.set(kf, 1);
  }
  const uniB = uniOf.filter(u => u === 'B').length;
  const uniF = N - uniB;
  const degs = P.map(p => p[3]).sort((a, b) => a - b);
  const degMed = degs[Math.floor(N / 2)];
  const degAvg = (R.length * 2 / N).toFixed(1);
  const hubs = P.map((p, i) => i).sort((a, b) => P[b][3] - P[a][3]).slice(0, 12);
  const maxType = Math.max(...typeCount);

  $('#v-panorama').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="eyebrow">Productos</div><div class="v">${fmt(N)}</div><div class="l">${fmt(uniB)} bienestar · ${fmt(uniF)} farma</div></div>
      <div class="kpi"><div class="eyebrow">Relaciones</div><div class="v">${fmt(R.length)}</div><div class="l">7 tipos en uso · 100 % justificadas</div></div>
      <div class="kpi"><div class="eyebrow">Cobertura</div><div class="v">100 %</div><div class="l">0 productos aislados (grado 0)</div></div>
      <div class="kpi"><div class="eyebrow">Grado</div><div class="v">${degAvg}</div><div class="l">medio · mediana ${degMed} · máx ${degs[N-1]}</div></div>
      <div class="kpi"><div class="eyebrow">Confianza Alta</div><div class="v">${(confCount[0]/R.length*100).toFixed(1)} %</div><div class="l">${fmt(confCount[0])} aristas</div></div>
      <div class="kpi"><div class="eyebrow">Reciprocidad</div><div class="v">${(recip/R.length*100).toFixed(1)} %</div><div class="l">aristas con inversa del mismo tipo</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-h"><h3>Distribución por tipo de relación</h3><span class="note">clic para explorar</span></div>
        <div class="card-b">
          ${TYPE_META.map((tm, t) => `
            <button class="bar-row" style="width:100%;text-align:left" data-t="${t}" title="${esc(tm.desc)}">
              <span class="lbl"><span class="dot" style="background:${tm.hex}"></span>${tm.label}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${(typeCount[t]/maxType*100).toFixed(1)}%;background:${tm.hex}"></span></span>
              <span class="bar-val">${fmt(typeCount[t])} · ${(typeCount[t]/R.length*100).toFixed(1)} %</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Confianza por tipo</h3><span class="note">política: excluir Baja en motores</span></div>
        <div class="card-b">
          ${TYPE_META.map((tm, t) => {
            const tot = typeCount[t] || 1;
            return `<div class="bar-row">
              <span class="lbl"><span class="dot" style="background:${tm.hex}"></span>${tm.label}</span>
              <span class="stack">
                <span style="width:${confByType[t][0]/tot*100}%;background:#0C7C59"></span>
                <span style="width:${confByType[t][1]/tot*100}%;background:#D98E2B"></span>
                <span style="width:${confByType[t][2]/tot*100}%;background:#BC4438"></span>
              </span>
              <span class="bar-val">${(confByType[t][0]/tot*100).toFixed(0)} % alta</span>
            </div>`;
          }).join('')}
          <div class="legend">
            <span><span class="dot" style="background:#0C7C59"></span>Alta ${fmt(confCount[0])}</span>
            <span><span class="dot" style="background:#D98E2B"></span>Media ${fmt(confCount[1])}</span>
            <span><span class="dot" style="background:#BC4438"></span>Baja ${fmt(confCount[2])}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-32">
      <div class="card">
        <div class="card-h"><h3>Hubs de conectividad</h3><span class="note">candidatos a límite de frecuencia (R-PIG-05)</span></div>
        <table>
          <thead><tr><th>#</th><th>Producto</th><th>Subcategoría</th><th>Grado</th></tr></thead>
          <tbody>${hubs.map((i, r) => `
            <tr class="rowlink" data-i="${i}">
              <td class="mono" style="color:var(--ink-3)">${r+1}</td>
              <td style="font-weight:500">${esc(P[i][1])}</td>
              <td style="color:var(--ink-2)">${P[i][2] >= 0 ? esc(SC[P[i][2]]) : '—'}</td>
              <td><div class="deg-cell"><span class="deg-bar" style="width:${(P[i][3]/degs[N-1]*70).toFixed(0)}px"></span><span class="mono">${P[i][3]}</span></div></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-h"><h3>Registro de riesgos</h3><span class="note">heredado del catálogo maestro</span></div>
        <div class="card-b" style="display:flex;flex-direction:column;gap:12px">
          ${RISKS.map(r => `
            <div style="display:flex;gap:10px;align-items:flex-start">
              <span class="risk-lv risk-${r[3]}">${r[3]}</span>
              <div style="min-width:0">
                <div style="font-weight:500;font-size:13px"><span class="mono" style="font-size:10.5px;color:var(--ink-3)">${r[0]}</span> · ${esc(r[1])}</div>
                <div style="font-size:12px;color:var(--ink-3);margin-top:1px">${esc(r[4])}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;

  $('#v-panorama').querySelectorAll('[data-t]').forEach(el =>
    el.addEventListener('click', () => { exState.type = +el.dataset.t; exState.page = 1; showView('explorador'); renderExplorador(); }));
  $('#v-panorama').querySelectorAll('tr[data-i]').forEach(el =>
    el.addEventListener('click', () => openProduct(+el.dataset.i)));
}

/* ================= EXPLORADOR ================= */
const exState = {q:'', uni:'', fam:'', type:-1, aud:-1, sort:'deg', page:1};
const PAGE = 40;

function exFilter() {
  const q = norm(exState.q.trim());
  const terms = q ? q.split(/\s+/) : null;
  const out = [];
  for (let i = 0; i < N; i++) {
    if (exState.uni && uniOf[i] !== exState.uni) continue;
    if (exState.fam && famOf[i] !== exState.fam) continue;
    if (exState.aud >= 0 && !P[i][5].includes(exState.aud)) continue;
    if (exState.type >= 0 && !adj[i].some(e => e.t === exState.type)) continue;
    if (terms && !terms.every(t => norm(searchBlob[i]).includes(t))) continue;
    out.push(i);
  }
  if (exState.sort === 'deg') out.sort((a, b) => P[b][3] - P[a][3]);
  else out.sort((a, b) => P[a][1] < P[b][1] ? -1 : 1);
  return out;
}

function renderExplorador() {
  const v = $('#v-explorador');
  v.innerHTML = `
    <div class="filters">
      <input type="text" id="ex-q" placeholder="Filtrar por nombre, SKU o tag…" value="${esc(exState.q)}" aria-label="Filtrar productos">
      <div class="seg" role="group" aria-label="Universo">
        <button data-uni="" class="${exState.uni === '' ? 'on' : ''}">Todo</button>
        <button data-uni="B" class="${exState.uni === 'B' ? 'on' : ''}">Bienestar</button>
        <button data-uni="F" class="${exState.uni === 'F' ? 'on' : ''}">Farma</button>
      </div>
      <select id="ex-fam" aria-label="Familia">
        <option value="">Todas las familias</option>
        ${famList.map(f => `<option value="${f}" ${exState.fam === f ? 'selected' : ''}>${f} · ${FAMILY[f]}</option>`).join('')}
      </select>
      <select id="ex-type" aria-label="Tipo de relación">
        <option value="-1">Cualquier relación</option>
        ${TYPE_META.map((tm, t) => `<option value="${t}" ${exState.type === t ? 'selected' : ''}>Tiene: ${tm.label}</option>`).join('')}
      </select>
      <select id="ex-aud" aria-label="Audiencia">
        <option value="-1">Toda audiencia</option>
        ${DATA.auds.map((a, i) => `<option value="${i}" ${exState.aud === i ? 'selected' : ''}>${a}</option>`).join('')}
      </select>
      <select id="ex-sort" aria-label="Orden">
        <option value="deg" ${exState.sort === 'deg' ? 'selected' : ''}>Más conectados</option>
        <option value="name" ${exState.sort === 'name' ? 'selected' : ''}>A → Z</option>
      </select>
      <span class="count-note" id="ex-count"></span>
    </div>
    <div class="card"><div id="ex-list"></div></div>`;

  $('#ex-q').addEventListener('input', e => { exState.q = e.target.value; exState.page = 1; exList(); });
  v.querySelectorAll('[data-uni]').forEach(b => b.addEventListener('click', () => {
    exState.uni = b.dataset.uni; exState.fam = ''; exState.page = 1; renderExplorador();
  }));
  $('#ex-fam').addEventListener('change', e => { exState.fam = e.target.value; exState.page = 1; exList(); });
  $('#ex-type').addEventListener('change', e => { exState.type = +e.target.value; exState.page = 1; exList(); });
  $('#ex-aud').addEventListener('change', e => { exState.aud = +e.target.value; exState.page = 1; exList(); });
  $('#ex-sort').addEventListener('change', e => { exState.sort = e.target.value; exState.page = 1; exList(); });
  exList();
}

function exList() {
  const res = exFilter();
  $('#ex-count').textContent = `${fmt(res.length)} producto${res.length === 1 ? '' : 's'}`;
  const shown = res.slice(0, exState.page * PAGE);
  const maxDeg = 229;
  $('#ex-list').innerHTML = !res.length
    ? `<div class="empty">Sin resultados con estos filtros. Prueba a quitar alguno o cambia el término de búsqueda.</div>`
    : `<table>
        <thead><tr><th>SKU</th><th>Producto</th><th>Subcategoría</th><th>Universo</th><th>Grado</th></tr></thead>
        <tbody>${shown.map(i => `
          <tr class="rowlink" data-i="${i}">
            <td class="mono" style="color:var(--ink-3)">${P[i][0]}</td>
            <td style="font-weight:500">${esc(P[i][1])}</td>
            <td style="color:var(--ink-2)">${P[i][2] >= 0 ? esc(SC[P[i][2]]) : '—'}</td>
            <td><span class="chip uni-${uniOf[i]}">${uniOf[i] === 'B' ? 'Bienestar' : 'Farma'}</span></td>
            <td><div class="deg-cell"><span class="deg-bar" style="width:${Math.max(4,(P[i][3]/maxDeg*70)).toFixed(0)}px"></span><span class="mono">${P[i][3]}</span></div></td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${shown.length < res.length ? `<button class="showmore" id="ex-more">Mostrar ${Math.min(PAGE, res.length - shown.length)} más (${fmt(res.length - shown.length)} restantes)</button>` : ''}`;
  document.querySelectorAll('#ex-list tr[data-i]').forEach(el =>
    el.addEventListener('click', () => openProduct(+el.dataset.i)));
  const more = $('#ex-more');
  if (more) more.addEventListener('click', () => { exState.page++; exList(); });
}

/* ================= PRODUCTO 360 ================= */
let p360Current = -1;
const p360Expanded = new Set();

/* ---------- ai sales copilot ---------- */
const COPILOT_SKILLS = [
  { key: 'explain-product', icon: '🤖', title: 'Explicar producto', desc: 'Explica beneficios, usos y público objetivo.', bg: 'var(--emerald-tint)', fg: 'var(--emerald-dk)' },
  { key: null, icon: '⚖️', title: 'Comparar productos', desc: 'Compara dos productos comercialmente.', bg: 'var(--indigo-tint)', fg: 'var(--indigo)' },
  { key: null, icon: '💰', title: 'Precio y disponibilidad', desc: 'Consulta precio, stock y estado.', bg: 'var(--amber-tint)', fg: '#8A5A14' },
  { key: null, icon: '💲', title: 'Mejor alternativa', desc: 'Encuentra el mejor sustituto.', bg: 'rgba(122,95,191,.14)', fg: 'var(--t2)' },
  { key: null, icon: '🧠', title: 'Venta cruzada inteligente', desc: 'Sugiere productos complementarios y explica por qué recomendarlos.', bg: 'rgba(194,85,127,.14)', fg: 'var(--t5)' },
];

// Proveedor activo del AI Sales Copilot — hoy, el local (sin red, sin IA).
// Reemplazarlo por Gemini (u otro proveedor real) más adelante se reduce a
// cambiar ESTA línea por `ResponseProvider.use(GeminiResponseProvider);`:
// ni el panel, ni ContextBuilder, ni Producto 360 necesitan tocarse — ver
// docs/ARCHITECTURE.md.
ResponseProvider.use(LocalResponseProvider);

// Estado de la única habilidad implementada en este paso ("Explicar
// producto"). Sigue el mismo patrón que p360Expanded: vive a nivel de
// módulo, se reinicia en openProduct() y sobrevive a los re-render parciales
// del panel (p. ej. al expandir "mostrar más" en un grupo de relaciones).
let copilotExplain = { status: 'idle', text: null, source: null, generatedAt: null, error: null };

function copilotSkillRowHTML(skill, idx) {
  const isExplain = skill.key === 'explain-product';
  const status = isExplain ? copilotExplain.status : 'idle';
  const isOpen = isExplain && (status === 'done' || status === 'error');

  const statusLabel = !isExplain ? 'Próximamente'
    : status === 'loading' ? 'Generando…'
    : status === 'error' ? 'No se pudo generar'
    : status === 'done' ? 'Disponible'
    : 'Disponible';
  const statusClass = !isExplain ? '' : status === 'error' ? 'is-error' : 'is-active';

  const rowHTML = `
    <button class="copilot-row${isOpen ? ' is-open' : ''}${status === 'loading' ? ' is-loading' : ''}" type="button"
      ${isExplain ? 'data-skill="explain-product"' : ''}
      ${status === 'loading' ? 'aria-busy="true" disabled' : ''}>
      <span class="copilot-ic" style="background:${skill.bg};color:${skill.fg}">${skill.icon}<span class="copilot-ic-n">${idx + 1}</span></span>
      <span class="copilot-row-txt">
        <span class="copilot-row-title">${skill.title}</span>
        <span class="copilot-row-desc">${skill.desc}</span>
        <span class="copilot-row-status${statusClass ? ' ' + statusClass : ''}">${statusLabel}</span>
      </span>
      <span class="copilot-chev${isOpen ? ' is-open' : ''}">›</span>
    </button>`;

  let extraHTML = '';
  if (isExplain && status === 'loading') {
    extraHTML = `<div class="copilot-response-loading"><span class="dot-live"></span>Generando explicación…</div>`;
  } else if (isExplain && status === 'done') {
    const time = copilotExplain.generatedAt
      ? new Date(copilotExplain.generatedAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
      : '';
    extraHTML = `
      <div class="copilot-response">
        <div class="copilot-response-h"><span class="dot-live"></span>Respuesta · ${esc(copilotExplain.source || 'local')} · ${time}</div>
        ${esc(copilotExplain.text)}
      </div>`;
  } else if (isExplain && status === 'error') {
    extraHTML = `<div class="copilot-response-err">${esc(copilotExplain.error)}</div>`;
  }

  return `<div class="copilot-skill-block">${rowHTML}${extraHTML}</div>`;
}

function copilotPanelHTML() {
  return `
    <aside class="card copilot-panel">
      <div class="copilot-top">
        <span class="copilot-avatar">🤖</span>
        <div class="copilot-top-txt">
          <div class="copilot-top-row"><h3>AI Sales Copilot</h3><span class="copilot-pill">Próximamente</span></div>
          <p class="copilot-sub">Tu asistente inteligente para vender más y mejor.</p>
        </div>
      </div>
      <div class="copilot-skills-h">
        <span>Mis 5 habilidades</span>
        <span class="copilot-info" title="Habilidades planificadas para el AI Sales Copilot">i</span>
      </div>
      <div class="copilot-skills">
        ${COPILOT_SKILLS.map((s, idx) => copilotSkillRowHTML(s, idx)).join('')}
      </div>
      <div class="copilot-foot"><span class="copilot-foot-ic">🛡️</span><span>Respuestas basadas en tu catálogo, inventario y relaciones internas — potenciado por IA (próximamente).</span></div>
    </aside>`;
}

function wireCopilotPanel() {
  const btn = $('[data-skill="explain-product"]');
  if (btn) btn.addEventListener('click', onExplainProductClick);
}

function refreshCopilotPanel() {
  const el = $('.copilot-panel');
  if (!el) return; // sin producto seleccionado, el panel no está montado
  el.outerHTML = copilotPanelHTML();
  wireCopilotPanel();
}

function onExplainProductClick() {
  if (copilotExplain.status === 'loading' || p360Current < 0) return;

  copilotExplain = { status: 'loading', text: null, source: null, generatedAt: null, error: null };
  refreshCopilotPanel();

  // maxPerType alto: la habilidad "Explicar producto" lee relaciones.detalle
  // para extraer beneficios y un ejemplo concreto, y se beneficia de ver más
  // muestras por tipo que el default (8) usado en el resto del sistema.
  let context;
  try {
    context = ContextBuilder.build(p360Current, { maxPerType: 15 });
  } catch (err) {
    copilotExplain = { status: 'error', text: null, source: null, generatedAt: null, error: err.message };
    refreshCopilotPanel();
    return;
  }
  if (!context) {
    copilotExplain = { status: 'error', text: null, source: null, generatedAt: null, error: 'No se pudo construir el contexto de este producto.' };
    refreshCopilotPanel();
    return;
  }

  ResponseProvider.get().explainProduct(context)
    .then(res => {
      copilotExplain = { status: 'done', text: res.text, source: res.source, generatedAt: res.generatedAt, error: null };
      refreshCopilotPanel();
    })
    .catch(err => {
      copilotExplain = { status: 'error', text: null, source: null, generatedAt: null, error: err.message || 'Ocurrió un error generando la respuesta.' };
      refreshCopilotPanel();
    });
}

function openProduct(i) {
  p360Current = i;
  p360Expanded.clear();
  copilotExplain = { status: 'idle', text: null, source: null, generatedAt: null, error: null };
  showView('p360');
  renderP360();
}

function renderP360() {
  const v = $('#v-p360');
  if (p360Current < 0) {
    v.innerHTML = `<div class="card"><div class="empty">Busca un producto arriba o elígelo desde el Explorador para ver su red completa.</div></div>`;
    return;
  }
  const i = p360Current, p = P[i];
  const groups = TYPE_META.map(() => []);
  for (const e of adj[i]) groups[e.t].push(e);
  for (const g of groups) g.sort((a, b) => a.c - b.c || P[b.o][3] - P[a.o][3]);
  const tags = p[4] ? p[4].split(',').map(s => s.trim()).filter(Boolean) : [];

  v.innerHTML = `
    <div class="p360-layout">
    <div class="p360-content">
    <div class="p360-head">
      <div class="who">
        <span class="eyebrow">SKU ${p[0]}</span>
        <h2>${esc(p[1])}</h2>
        <div class="meta-line">
          <span class="chip uni-${uniOf[i]}">${uniOf[i] === 'B' ? 'Bienestar' : 'Farma'}</span>
          ${p[2] >= 0 ? `<span>${esc(SC[p[2]])}</span>` : ''}
          ${famOf[i] ? `<span style="color:var(--ink-3)">· ${esc(FAMILY[famOf[i]])}</span>` : ''}
          ${p[5].map(a => `<span class="tag">${DATA.auds[a]}</span>`).join('')}
          <span style="color:var(--ink-3)">· ${p[3]} relaciones</span>
        </div>
        <div style="margin-top:9px">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>
      <button class="chip" style="background:var(--ink);color:#fff;padding:8px 16px;font-size:12.5px" id="p360-to-engine">Ver recomendaciones →</button>
    </div>

    <div class="grid-32">
      <div class="card">
        <div class="card-h"><h3>Órbita de relaciones</h3><span class="note">pasa el cursor · clic para navegar</span></div>
        <div class="orbit-wrap"><canvas id="orbit" height="420" aria-label="Grafo de relaciones del producto"></canvas><div class="orbit-tip" id="orbit-tip"></div></div>
        <div class="orbit-legend">${TYPE_META.filter((_, t) => groups[t].length).map(tm =>
          `<span><span class="dot" style="background:${tm.hex}"></span>${tm.label}</span>`).join('')}
          <span style="margin-left:auto;color:var(--ink-3)">tamaño = confianza · máx. 72 vecinos priorizando Alta</span>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Composición de la red</h3></div>
        <div class="card-b">
          ${TYPE_META.map((tm, t) => groups[t].length ? `
            <div class="bar-row">
              <span class="lbl"><span class="dot" style="background:${tm.hex}"></span>${tm.label}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${(groups[t].length / p[3] * 100).toFixed(1)}%;background:${tm.hex}"></span></span>
              <span class="bar-val">${groups[t].length}</span>
            </div>` : '').join('')}
          <div style="font-size:12px;color:var(--ink-3);margin-top:10px">Confianza:
            ${[0,1,2].map(c => { const n = adj[i].filter(e => e.c === c).length; return n ? `<span class="chip ${CONF_META[c].cls}" style="margin-left:6px">${CONF_META[c].label} ${n}</span>` : ''; }).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="rel-groups">
      ${TYPE_META.map((tm, t) => {
        const g = groups[t];
        if (!g.length) return '';
        const open = p360Expanded.has(t);
        const shown = open ? g : g.slice(0, 5);
        return `<div class="card rel-g">
          <div class="rel-g-h"><span class="dot" style="background:${tm.hex}"></span><h4>${tm.label}</h4><span style="font-size:12px;color:var(--ink-3)">${tm.desc}</span><span class="n">${g.length}</span></div>
          ${shown.map(e => `
            <div class="rel-item">
              <div><a class="link" data-i="${e.o}">${esc(P[e.o][1])}</a> <span class="mono" style="font-size:11px;color:var(--ink-3)">· ${P[e.o][0]}</span></div>
              <span class="chip ${CONF_META[e.c].cls}">${CONF_META[e.c].label}</span>
              <div class="just">${esc(J[e.j])}</div>
            </div>`).join('')}
          ${g.length > 5 ? `<button class="showmore" data-g="${t}">${open ? 'Mostrar menos' : `Mostrar los ${g.length - 5} restantes`}</button>` : ''}
        </div>`;
      }).join('')}
    </div>
    </div>
    ${copilotPanelHTML()}
    </div>`;

  $('#p360-to-engine').addEventListener('click', () => { engineState.product = i; showView('motores'); renderMotores(); });
  wireCopilotPanel();
  v.querySelectorAll('a[data-i]').forEach(a => a.addEventListener('click', () => openProduct(+a.dataset.i)));
  v.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => {
    const t = +b.dataset.g;
    p360Expanded.has(t) ? p360Expanded.delete(t) : p360Expanded.add(t);
    renderP360();
  }));
  drawOrbit(i, groups);
}

/* ---------- ego-graph canvas ---------- */
function drawOrbit(center, groups) {
  const cv = $('#orbit'), tip = $('#orbit-tip');
  const wrap = cv.parentElement;
  const W = wrap.clientWidth, H = 420, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  // pick up to 72 neighbors, proportionally per type, Alta first
  const CAP = 72;
  const total = groups.reduce((s, g) => s + g.length, 0);
  const picked = [];
  for (let t = 0; t < groups.length; t++) {
    const g = groups[t];
    if (!g.length) continue;
    const quota = Math.max(1, Math.round(g.length / total * CAP));
    for (const e of g.slice(0, quota)) picked.push({...e});
  }
  // angular sectors proportional to picked counts per type
  const byType = TYPE_META.map((_, t) => picked.filter(e => e.t === t));
  const cx = W / 2, cy = H / 2;
  const nodes = [];
  let ang = -Math.PI / 2;
  const gap = 0.06;
  const totPicked = picked.length || 1;
  for (let t = 0; t < byType.length; t++) {
    const g = byType[t];
    if (!g.length) continue;
    const span = (Math.PI * 2 - gap * byType.filter(x => x.length).length) * (g.length / totPicked);
    for (let k = 0; k < g.length; k++) {
      const a = ang + span * ((k + 0.5) / g.length);
      const ring = 130 + (k % 3) * 32 + (g[k].c * 8);
      nodes.push({x: cx + Math.cos(a) * Math.min(ring, Math.min(W, H) / 2 - 26),
                  y: cy + Math.sin(a) * (ring * 0.72 > H / 2 - 26 ? H / 2 - 26 : ring * 0.72),
                  e: g[k]});
    }
    ang += span + gap;
  }

  function paint(hover) {
    ctx.clearRect(0, 0, W, H);
    // edges
    for (const nd of nodes) {
      const tm = TYPE_META[nd.e.t];
      ctx.strokeStyle = tm.hex;
      ctx.globalAlpha = hover === nd ? 0.95 : (nd.e.c === 0 ? 0.5 : nd.e.c === 1 ? 0.3 : 0.18);
      ctx.lineWidth = hover === nd ? 2.2 : (nd.e.c === 0 ? 1.5 : 1);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nd.x, nd.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // neighbor nodes
    for (const nd of nodes) {
      const tm = TYPE_META[nd.e.t];
      const r = (nd.e.c === 0 ? 6 : nd.e.c === 1 ? 4.6 : 3.6) + (hover === nd ? 2 : 0);
      ctx.fillStyle = tm.hex;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2); ctx.fill();
      if (hover === nd) { ctx.strokeStyle = '#16241E'; ctx.lineWidth = 1.6; ctx.stroke(); }
    }
    // center
    ctx.fillStyle = '#16241E';
    ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '600 9px "IBM Plex Mono",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SKU', cx, cy);
  }
  paint(null);

  let hovered = null;
  function nearest(mx, my) {
    let best = null, bd = 14 * 14;
    for (const nd of nodes) {
      const d = (nd.x - mx) ** 2 + (nd.y - my) ** 2;
      if (d < bd) { bd = d; best = nd; }
    }
    return best;
  }
  cv.onmousemove = ev => {
    const rc = cv.getBoundingClientRect();
    const nd = nearest(ev.clientX - rc.left, ev.clientY - rc.top);
    if (nd !== hovered) { hovered = nd; paint(nd); }
    cv.style.cursor = nd ? 'pointer' : 'default';
    if (nd) {
      tip.style.display = 'block';
      tip.style.left = Math.min(nd.x + 14, W - 270) + 'px';
      tip.style.top = (nd.y + 12) + 'px';
      tip.innerHTML = `<strong>${esc(P[nd.e.o][1])}</strong><br>${TYPE_META[nd.e.t].label} · confianza ${CONF_META[nd.e.c].label}`;
    } else tip.style.display = 'none';
  };
  cv.onmouseleave = () => { hovered = null; tip.style.display = 'none'; paint(null); };
  cv.onclick = ev => {
    const rc = cv.getBoundingClientRect();
    const nd = nearest(ev.clientX - rc.left, ev.clientY - rc.top);
    if (nd) openProduct(nd.e.o);
  };
}

/* ================= MOTORES ================= */
const engineState = {product: -1, tab: 'cross', includeBaja: false};

function engineRecos(i) {
  const agg = new Map();
  for (const e of adj[i]) {
    if (!engineState.includeBaja && e.c === 2) continue;
    let bucket = null, w = 0;
    if (engineState.tab === 'cross' && CROSS_TYPE_W[e.t] !== undefined) { bucket = 'x'; w = CROSS_TYPE_W[e.t] * CONF_W[e.c]; }
    if (engineState.tab === 'subs' && e.t === 3) { bucket = 'x'; w = 3 * CONF_W[e.c]; }
    if (engineState.tab === 'vars' && (e.t === 6 || e.t === 2)) { bucket = 'x'; w = (e.t === 6 ? 3 : 1) * CONF_W[e.c]; }
    if (!bucket) continue;
    if (!agg.has(e.o)) agg.set(e.o, {score: 0, reasons: []});
    const a = agg.get(e.o);
    a.score += w;
    a.reasons.push(e);
  }
  return [...agg.entries()]
    .sort((a, b) => b[1].score - a[1].score || P[b[0]][3] - P[a[0]][3])
    .slice(0, 12);
}

function renderMotores() {
  const v = $('#v-motores');
  const i = engineState.product;
  const tabs = [
    ['cross', 'Venta cruzada', 'Complementa ×3.0 · Mismo beneficio ×2.0 · Misma audiencia ×1.5 · Mismo ingrediente ×1.0, ponderado por confianza (Alta ×1.0, Media ×0.6).'],
    ['subs', 'Sustitución', 'Solo relaciones SUSTITUYE. Techo de confianza Media por diseño (R-PIG-03): validar muestralmente antes de activar en canal.'],
    ['vars', 'Variantes', 'VARIANTE (sabor/momento/tamaño) primero; MISMO_INGREDIENTE como candidato ampliado de surtido.'],
  ];
  const tabDesc = tabs.find(t => t[0] === engineState.tab)[2];

  v.innerHTML = `
    <div class="pick-box">
      <span style="font-weight:500;font-size:13px">Producto base:</span>
      <div class="gsearch" style="width:360px">
        <svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 3.5 3.5"/></svg>
        <input id="en-q" type="text" placeholder="Buscar producto base…" autocomplete="off" aria-label="Producto base para recomendaciones">
        <div class="gs-drop" id="en-drop"></div>
      </div>
      ${i >= 0 ? `<span class="chip" style="background:var(--emerald-tint);color:var(--emerald-dk);font-size:12px;padding:6px 12px">${esc(P[i][1])} · ${P[i][0]}</span>
      <a class="link" style="font-size:12.5px" id="en-open360">abrir 360 →</a>` : ''}
    </div>
    <div class="engine-tabs">${tabs.map(t =>
      `<button data-tab="${t[0]}" class="${engineState.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}
    </div>
    <div class="policy">
      <strong>Política R-PIG-04:</strong> las aristas de confianza Baja quedan fuera de los motores por defecto.
      <label><input type="checkbox" id="en-baja" ${engineState.includeBaja ? 'checked' : ''}> Incluir Baja (auditoría)</label>
    </div>
    <div class="card">
      <div class="card-h"><h3>${tabs.find(t => t[0] === engineState.tab)[1]}</h3><span class="note">${tabDesc}</span></div>
      <div id="en-out"></div>
    </div>`;

  const enIn = $('#en-q'), enDrop = $('#en-drop');
  function enRender() {
    const res = searchProducts(enIn.value);
    enDrop.innerHTML = res.map(x => `
      <button class="gs-item" data-i="${x}">
        <div class="nm">${esc(P[x][1])}</div>
        <div class="mt">SKU ${P[x][0]} · ${P[x][3]} relaciones</div>
      </button>`).join('');
    enDrop.classList.toggle('open', !!res.length);
    enDrop.querySelectorAll('.gs-item').forEach(el =>
      el.addEventListener('click', () => { engineState.product = +el.dataset.i; renderMotores(); }));
  }
  enIn.addEventListener('input', enRender);
  enIn.addEventListener('focus', enRender);
  v.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { engineState.tab = b.dataset.tab; renderMotores(); }));
  $('#en-baja').addEventListener('change', e => { engineState.includeBaja = e.target.checked; renderMotores(); });
  const o360 = $('#en-open360');
  if (o360) o360.addEventListener('click', () => openProduct(i));

  const out = $('#en-out');
  if (i < 0) {
    out.innerHTML = `<div class="empty">Elige un producto base para generar recomendaciones justificadas.</div>`;
    return;
  }
  const recos = engineRecos(i);
  out.innerHTML = !recos.length
    ? `<div class="empty">Este producto no tiene relaciones elegibles para este motor con la política actual.</div>`
    : recos.map(([o, r], k) => `
      <div class="reco">
        <div class="rank">${String(k + 1).padStart(2, '0')}</div>
        <div>
          <a class="link" data-i="${o}" style="font-size:13.5px">${esc(P[o][1])}</a>
          <span class="mono" style="font-size:11px;color:var(--ink-3)"> · ${P[o][0]} · ${P[o][2] >= 0 ? esc(SC[P[o][2]]) : '—'}</span>
        </div>
        <span class="score-pill">${r.score.toFixed(1)}</span>
        <div class="why">${r.reasons.map(e =>
          `<span><span class="dot" style="background:${TYPE_META[e.t].hex};width:7px;height:7px;border-radius:2px"></span> ${TYPE_META[e.t].label} <span class="chip ${CONF_META[e.c].cls}" style="font-size:10px;padding:1px 7px">${CONF_META[e.c].label}</span> — ${esc(J[e.j])}</span>`).join('')}
        </div>
      </div>`).join('');
  out.querySelectorAll('a[data-i]').forEach(a => a.addEventListener('click', () => openProduct(+a.dataset.i)));
}

/* ---------- boot ---------- */
renderPanorama();
renderExplorador();
renderP360();
renderMotores();
window.addEventListener('resize', () => { if (currentView === 'p360' && p360Current >= 0) renderP360(); });
