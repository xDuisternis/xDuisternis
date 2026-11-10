import LANGS from './langs.json';
import { processFile, pool, defaultThreads, CancelledError, IMAGE_TYPES } from './engine.js';
import { FORMATS, exportOne, exportZip, toTxt } from './exporters.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Preferencias (solo comodidad local; la app funciona sin ellas) ----------
const PREFS_KEY = 'duisternis-ocr-prefs';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } };
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(getOpts())); } catch { /* sin almacenamiento */ } };
const prefs = loadPrefs();

$('#langs').innerHTML = LANGS.map(({ code, name }) =>
  `<label class="chip"><input type="checkbox" value="${code}" ${(prefs.langs || ['spa', 'eng']).includes(code) ? 'checked' : ''}/> ${name}</label>`).join('');
if (prefs.mode) document.querySelector(`input[name=mode][value=${prefs.mode}]`).checked = true;
if (prefs.dpi) $('#dpi').value = String(prefs.dpi);
$('#threads').value = prefs.threads || defaultThreads();
$('#searchable').checked = !!prefs.searchablePdf;

function getOpts() {
  let langs = [...document.querySelectorAll('#langs input:checked')].map((i) => i.value);
  if (!langs.length) langs = ['spa'];
  return {
    langs,
    mode: document.querySelector('input[name=mode]:checked').value,
    dpi: Number($('#dpi').value),
    threads: Math.max(1, Math.min(16, Number($('#threads').value) || defaultThreads())),
    searchablePdf: $('#searchable').checked,
  };
}
$('#opts').addEventListener('change', savePrefs);

// ---------- Estado ----------
let items = []; // { id, file, name, status, done, total, pages, pdfParts, sourceBytes, error, msg }
let selected = null;
let running = false;
let cancelFlag = false;
let seq = 0;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function addFiles(list) {
  const accepted = [...list].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name) || f.type.startsWith('image/') || IMAGE_TYPES.test(f.name));
  const skipped = list.length - accepted.length;
  if (skipped) toast(`${skipped} archivo(s) ignorado(s): formato no compatible`);
  for (const file of accepted) {
    items.push({ id: ++seq, file, name: file.name || `captura-${seq}.png`, status: 'pending', done: 0, total: 0, pages: [], pdfParts: null, sourceBytes: null });
  }
  render();
  run();
}

// ---------- Cola de procesamiento ----------
async function run() {
  if (running) return;
  running = true; cancelFlag = false;
  render();
  try {
    let item;
    while (!cancelFlag && (item = items.find((i) => i.status === 'pending'))) {
      const opts = getOpts();
      item.status = 'processing'; item.pages = []; item.done = 0; item.total = 0; item.error = null; item.msg = 'Abriendo…';
      if (!selected) selected = item.id;
      render();
      const t0 = performance.now();
      try {
        const res = await processFile(item.file, opts, {
          isCancelled: () => cancelFlag || !items.includes(item),
          onStatus: (msg) => { item.msg = msg; renderItem(item); },
          onPage: (page, done, total) => {
            item.pages[page.n - 1] = page; item.done = done; item.total = total; item.msg = '';
            renderItem(item);
            if (selected === item.id) renderViewer(true);
          },
        });
        Object.assign(item, res, { status: 'done', msg: `${((performance.now() - t0) / 1000).toFixed(1)} s` });
      } catch (e) {
        if (e instanceof CancelledError || cancelFlag) { item.status = 'pending'; item.msg = 'Cancelado'; }
        else { console.error(e); item.status = 'error'; item.error = friendlyError(e); }
      }
      render();
    }
  } finally {
    running = false;
    if (cancelFlag) await pool.terminate();
    render();
    const ok = items.filter((i) => i.status === 'done').length;
    if (!cancelFlag && ok) toast(`Listo: ${ok} archivo(s) procesado(s)`);
  }
}

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/password/i.test(e?.name || '') || /password/i.test(m)) return 'PDF protegido con contraseña';
  if (/Invalid PDF|InvalidPDF/i.test(m) || e?.name === 'InvalidPDFException') return 'PDF dañado o no válido';
  if (/memory|allocation/i.test(m)) return 'Memoria insuficiente: baja la calidad o el número de hilos';
  return m;
}

// ---------- Render ----------
const STATUS = { pending: 'En cola', processing: 'Procesando', done: 'Listo', error: 'Error' };

function itemHtml(it) {
  const pct = it.status === 'done' ? 100 : it.total ? Math.round((it.done / it.total) * 100) : 0;
  const ocr = it.pages.filter((p) => p?.method === 'ocr').length;
  const native = it.pages.filter((p) => p?.method === 'native').length;
  const info = it.status === 'error' ? esc(it.error || '')
    : [it.total ? `${it.done}/${it.total} pág.` : '', native ? `${native} digitales` : '', ocr ? `${ocr} con OCR` : '', esc(it.msg || '')].filter(Boolean).join(' · ');
  return `<div class="q-main">
      <span class="badge ${it.status}">${STATUS[it.status]}</span>
      <span class="q-name" title="${esc(it.name)}">${esc(it.name)}</span>
      <span class="q-info">${info}</span>
    </div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <button class="x" data-remove="${it.id}" title="Quitar" aria-label="Quitar">×</button>`;
}

function renderItem(it) {
  const li = document.querySelector(`[data-id="${it.id}"]`);
  if (li) { li.innerHTML = itemHtml(it); li.className = `q ${selected === it.id ? 'sel' : ''}`; }
  updateSummary();
}

function updateSummary() {
  const pages = items.reduce((a, i) => a + i.pages.filter(Boolean).length, 0);
  const done = items.filter((i) => i.status === 'done').length;
  $('#summary').textContent = `${done}/${items.length} · ${pages} página(s)`;
}

function render() {
  $('#queue-section').hidden = !items.length;
  $('#queue').innerHTML = items.map((it) => `<li class="q ${selected === it.id ? 'sel' : ''}" data-id="${it.id}">${itemHtml(it)}</li>`).join('');
  $('#cancel').hidden = !running;
  $('#retry').hidden = running || !items.some((i) => i.status === 'done' || i.status === 'error');
  $('#dl-all').disabled = !items.some((i) => i.status === 'done');
  updateSummary();
  renderViewer();
}

let renderedFor = null;
function renderViewer(incremental = false) {
  const it = items.find((i) => i.id === selected);
  $('#viewer').hidden = !it || !it.pages.some(Boolean);
  if (!it) return;
  $('#viewer-title').textContent = it.name;
  $('#dl-one').disabled = it.status !== 'done';
  const box = $('#pages');
  if (!incremental || renderedFor !== it.id) { box.innerHTML = ''; renderedFor = it.id; }
  it.pages.forEach((p, idx) => {
    if (!p || box.querySelector(`[data-page="${idx}"]`)) return;
    const el = document.createElement('article');
    el.className = 'page'; el.dataset.page = idx;
    const conf = p.method === 'ocr' ? `<span class="conf ${p.confidence < 60 ? 'low' : ''}">confianza ${p.confidence}%</span>` : '';
    el.innerHTML = `<header><b>Página ${p.n}</b> <span class="tag ${p.method}">${p.method === 'ocr' ? 'OCR' : 'Texto digital'}</span> ${conf}
      <button class="btn small" data-copy="${idx}">Copiar</button></header>
      <textarea spellcheck="false" placeholder="(página sin texto)"></textarea>`;
    const ta = el.querySelector('textarea');
    ta.value = p.text;
    ta.addEventListener('input', () => { p.text = ta.value; autosize(ta); });
    // Insertar en orden aunque las páginas OCR terminen desordenadas
    const next = [...box.children].find((c) => Number(c.dataset.page) > idx);
    box.insertBefore(el, next || null);
    autosize(ta);
  });
  applySearch();
}

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 640)}px`; }

function applySearch() {
  const q = $('#search').value.trim().toLowerCase();
  let hits = 0;
  for (const el of document.querySelectorAll('#pages .page')) {
    const match = !q || el.querySelector('textarea').value.toLowerCase().includes(q);
    el.hidden = !match; if (q && match) hits++;
  }
  $('#search').title = q ? `${hits} página(s) con coincidencias` : '';
}

// ---------- Menús de descarga ----------
function fillMenu(menu, forAll) {
  const it = items.find((i) => i.id === selected);
  menu.innerHTML = Object.entries(FORMATS).map(([k, f]) => {
    const ok = forAll ? (!f.needs || items.some((i) => i.status === 'done' && f.needs(i))) : (it && (!f.needs || f.needs(it)));
    const hint = !ok && k === 'pdf' ? ' — activa «PDF buscable» y reprocesa' : '';
    return `<button data-fmt="${k}" ${ok ? '' : 'disabled'}>${forAll ? 'ZIP · ' : ''}${f.label}${hint}</button>`;
  }).join('');
}
function toggleMenu(btn, menu, forAll) {
  const open = menu.hidden;
  document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; });
  if (open) { fillMenu(menu, forAll); menu.hidden = false; }
}
$('#dl-one').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(e.currentTarget, $('#dl-one-menu'), false); });
$('#dl-all').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(e.currentTarget, $('#dl-all-menu'), true); });
document.addEventListener('click', () => document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; }));

async function guarded(fn) {
  try { toast('Generando archivo…'); await fn(); } catch (e) { console.error(e); toast(`No se pudo exportar: ${e.message}`); }
}
$('#dl-one-menu').addEventListener('click', (e) => {
  const fmt = e.target.closest('[data-fmt]')?.dataset.fmt; if (!fmt) return;
  const it = items.find((i) => i.id === selected);
  guarded(() => exportOne(it, fmt));
});
$('#dl-all-menu').addEventListener('click', (e) => {
  const fmt = e.target.closest('[data-fmt]')?.dataset.fmt; if (!fmt) return;
  const done = items.filter((i) => i.status === 'done');
  guarded(() => (done.length === 1 ? exportOne(done[0], fmt) : exportZip(done, fmt)));
});

// ---------- Eventos ----------
$('#file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles(e.dataTransfer.files); });
window.addEventListener('paste', (e) => {
  if (e.target.closest?.('textarea, input')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `captura-${Date.now()}-${i}.png`, { type: f.type })))); }
});

$('#queue').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const id = Number(rm.dataset.remove);
    items = items.filter((i) => i.id !== id);
    if (selected === id) selected = items.find((i) => i.pages.some(Boolean))?.id ?? null;
    render(); return;
  }
  const li = e.target.closest('[data-id]');
  if (li) { selected = Number(li.dataset.id); render(); }
});
$('#cancel').addEventListener('click', () => { cancelFlag = true; toast('Cancelando…'); });
$('#retry').addEventListener('click', () => {
  items.forEach((i) => { if (i.status !== 'processing') { i.status = 'pending'; i.pages = []; i.pdfParts = null; i.sourceBytes = null; } });
  renderedFor = null; run();
});
$('#clear').addEventListener('click', () => {
  if (running) cancelFlag = true;
  items = []; selected = null; renderedFor = null; render();
});
$('#copy').addEventListener('click', async () => {
  const it = items.find((i) => i.id === selected); if (!it) return;
  try { await navigator.clipboard.writeText(toTxt({ ...it, pages: it.pages.filter(Boolean) })); toast('Texto copiado'); } catch { toast('No se pudo copiar'); }
});
$('#pages').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.closest('.page').querySelector('textarea').value); toast('Página copiada'); } catch { toast('No se pudo copiar'); }
});
$('#search').addEventListener('input', applySearch);
window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

render();
