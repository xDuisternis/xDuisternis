// Motor de extracción: PDF digital (capa de texto nativa) + OCR (Tesseract WASM) para escaneos e imágenes.
// Todo se ejecuta en el navegador del usuario: sin servidor, sin límites de páginas, tamaño ni número de archivos.
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createScheduler, createWorker } from 'tesseract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const VENDOR = new URL('vendor/', document.baseURI).href;
const PDFJS_OPTS = {
  cMapUrl: `${VENDOR}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`,
  wasmUrl: `${VENDOR}pdfjs/wasm/`,
};

export const IMAGE_TYPES = /\.(png|jpe?g|webp|bmp|gif|tiff?|pbm|avif)$/i;
const MAX_SIDE = 5000; // px; evita agotar memoria con páginas gigantes (planos, pósters)

export class CancelledError extends Error {
  constructor() { super('Cancelado'); this.name = 'CancelledError'; }
}

/** Pool de workers de Tesseract (uno por núcleo útil) que procesan páginas en paralelo. */
class OcrPool {
  constructor() { this.scheduler = null; this.key = ''; this.size = 0; }

  async ensure(langs, size, onStatus) {
    const key = `${langs.join('+')}|${size}`;
    if (this.scheduler && this.key === key) return;
    await this.terminate();
    onStatus?.(`Cargando motor OCR (${size} hilos, idiomas: ${langs.join(', ')})…`);
    const scheduler = createScheduler();
    const workers = await Promise.all(Array.from({ length: size }, () => createWorker(langs, 1, {
      workerPath: `${VENDOR}tesseract/worker.min.js`,
      corePath: `${VENDOR}core`,
      langPath: `${VENDOR}lang`,
      workerBlobURL: false,
      gzip: true,
    })));
    for (const w of workers) {
      // PSM 3 = segmentación automática de página (columnas, bloques); conserva espacios entre palabras
      await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
      scheduler.addWorker(w);
    }
    this.scheduler = scheduler; this.key = key; this.size = size;
  }

  recognize(image, wantPdf) {
    return this.scheduler.addJob('recognize', image,
      { rotateAuto: true, pdfTitle: 'OCR' },
      { text: true, pdf: wantPdf });
  }

  async terminate() {
    const s = this.scheduler;
    this.scheduler = null; this.key = '';
    if (s) await s.terminate().catch(() => {});
  }
}

export const pool = new OcrPool();

export function defaultThreads() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8; // GB (solo Chromium lo expone); cada hilo OCR usa ~150 MB
  return Math.max(1, Math.min(cores - 1, mem <= 4 ? 2 : 8));
}

/** Reconstruye el texto de una página digital respetando saltos de línea. */
function textFromContent(content) {
  let out = '';
  let lastY = null;
  for (const it of content.items) {
    if (!('str' in it)) continue;
    const y = it.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
    out += it.str;
    if (it.hasEOL && !out.endsWith('\n')) out += '\n';
    if (y !== undefined) lastY = y;
  }
  return out;
}

export function cleanText(t) {
  return t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** ¿La capa de texto nativa es útil o hay que hacer OCR? */
function nativeTextIsUsable(text) {
  const visible = text.replace(/\s/g, '');
  if (visible.length < 25) return false; // página escaneada (sin texto o casi)
  // Fuentes con codificación rota: muchos caracteres de reemplazo / uso privado / control
  const bad = (visible.match(/[�-\u0000-\u0008]/g) || []).length;
  if (bad / visible.length > 0.1) return false;
  // Texto sin letras ni dígitos (basura) → OCR
  const alnum = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
  return alnum / visible.length > 0.4;
}

function canvasToBlob(canvas) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo rasterizar la página'))), 'image/png'));
}

async function renderPdfPage(page, dpi) {
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const longest = Math.max(base.width, base.height) * scale;
  if (longest > MAX_SIDE) scale *= MAX_SIDE / longest;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const blob = await canvasToBlob(canvas);
  canvas.width = canvas.height = 0; // libera memoria de inmediato
  return blob;
}

/** Normaliza imágenes (incluye las que Tesseract no decodifica, como WebP/AVIF/GIF) a PNG sobre fondo blanco. */
async function imageToBlob(file) {
  if (/\.(tiff?|pbm)$/i.test(file.name) || /image\/tiff/.test(file.type)) return file; // Tesseract las lee directamente
  const bmp = await createImageBitmap(file);
  let { width, height } = bmp;
  const f = Math.min(1, MAX_SIDE / Math.max(width, height));
  // Las capturas pequeñas se amplían: Tesseract rinde mejor con letras de ≥ 20 px
  const up = Math.max(width, height) < 1500 ? 2 : 1;
  width = Math.round(width * f * up); height = Math.round(height * f * up);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await canvasToBlob(canvas);
  canvas.width = canvas.height = 0;
  return blob;
}

/**
 * Procesa un archivo (PDF o imagen).
 * @param {File} file
 * @param {object} opts { langs, threads, mode: 'auto'|'ocr'|'native', dpi, searchablePdf, password }
 * @param {object} cb { onPage(pageResult, done, total), onStatus(msg), isCancelled() }
 * @returns {Promise<{pages: Array, pdfParts: Array|null, sourceBytes: ArrayBuffer|null}>}
 */
export async function processFile(file, opts, cb) {
  const check = () => { if (cb.isCancelled()) throw new CancelledError(); };
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  if (!isPdf) {
    await pool.ensure(opts.langs, opts.threads, cb.onStatus);
    check();
    cb.onStatus?.('Reconociendo imagen…');
    const img = await imageToBlob(file);
    const { data } = await pool.recognize(img, opts.searchablePdf);
    check();
    const page = { n: 1, method: 'ocr', confidence: Math.round(data.confidence ?? 0), text: cleanText(data.text || '') };
    cb.onPage(page, 1, 1);
    return { pages: [page], pdfParts: opts.searchablePdf ? [{ kind: 'ocr', bytes: data.pdf }] : null, sourceBytes: null };
  }

  const bytes = await file.arrayBuffer();
  check();
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), ...PDFJS_OPTS, password: opts.password });
  task.onPassword = (update, reason) => {
    const pwd = window.prompt(reason === 2 ? 'Contraseña incorrecta. Inténtalo de nuevo:' : `«${file.name}» está protegido. Introduce la contraseña:`);
    if (pwd === null) { task.destroy(); } else update(pwd);
  };
  const doc = await task.promise;
  const total = doc.numPages;
  const pages = new Array(total);
  const pdfParts = opts.searchablePdf ? new Array(total) : null;
  let done = 0;
  let ocrStarted = false;
  const inflight = new Set();

  try {
    for (let n = 1; n <= total; n++) {
      check();
      const page = await doc.getPage(n);
      let native = '';
      if (opts.mode !== 'ocr') native = cleanText(textFromContent(await page.getTextContent()));

      if (opts.mode === 'native' || (opts.mode === 'auto' && nativeTextIsUsable(native))) {
        pages[n - 1] = { n, method: 'native', confidence: 100, text: native };
        if (pdfParts) pdfParts[n - 1] = { kind: 'native', index: n - 1 };
        done++;
        cb.onPage(pages[n - 1], done, total);
        page.cleanup();
        continue;
      }

      if (!ocrStarted) { await pool.ensure(opts.langs, opts.threads, cb.onStatus); ocrStarted = true; }
      // Contrapresión: no rasterizar más páginas de las que el pool puede consumir (memoria acotada)
      while (inflight.size >= pool.size + 1) { await Promise.race(inflight); check(); }
      cb.onStatus?.(`Rasterizando página ${n}/${total}…`);
      const img = await renderPdfPage(page, opts.dpi);
      page.cleanup();
      check();
      const job = pool.recognize(img, !!pdfParts).then(({ data }) => {
        if (cb.isCancelled()) return;
        pages[n - 1] = { n, method: 'ocr', confidence: Math.round(data.confidence ?? 0), text: cleanText(data.text || '') };
        if (pdfParts) pdfParts[n - 1] = { kind: 'ocr', bytes: data.pdf };
        done++;
        cb.onPage(pages[n - 1], done, total);
      });
      const tracked = job.finally(() => inflight.delete(tracked));
      inflight.add(tracked);
    }
    await Promise.all(inflight);
    check();
  } finally {
    doc.destroy();
  }
  return { pages, pdfParts, sourceBytes: pdfParts ? bytes : null };
}
