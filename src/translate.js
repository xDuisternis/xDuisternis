// Traducción gratuita y sin clave usando el endpoint público del traductor de Google.
// El texto se divide en fragmentos (respetando párrafos y frases) que se traducen en paralelo
// con reintentos y espera exponencial si el servicio limita la velocidad.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=';
const MAX_CHARS = 4500;
const CONCURRENCY = 3;

export const TARGETS = [
  ['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'], ['de', 'Alemán'],
  ['it', 'Italiano'], ['ca', 'Catalán'], ['gl', 'Gallego'], ['eu', 'Euskera'], ['nl', 'Neerlandés'],
  ['pl', 'Polaco'], ['ro', 'Rumano'], ['ru', 'Ruso'], ['uk', 'Ucraniano'], ['ar', 'Árabe'],
  ['tr', 'Turco'], ['zh-CN', 'Chino (simplificado)'], ['ja', 'Japonés'], ['ko', 'Coreano'], ['hi', 'Hindi'],
];
export const targetName = (code) => TARGETS.find(([c]) => c === code)?.[1] || code;

/** Parte un texto en fragmentos ≤ max sin cortar párrafos, líneas ni frases si es posible. */
export function splitText(text, max = MAX_CHARS) {
  const out = [];
  let cur = '';
  const push = (piece, sep) => {
    if (cur && cur.length + sep.length + piece.length > max) { out.push(cur); cur = ''; }
    cur = cur ? cur + sep + piece : piece;
  };
  for (const para of text.split(/(?<=\n\n)/)) {
    if (para.length <= max) { push(para, ''); continue; }
    for (const sentence of para.split(/(?<=[.!?;:]\s|\n)/)) {
      if (sentence.length <= max) { push(sentence, ''); continue; }
      for (let i = 0; i < sentence.length; i += max) push(sentence.slice(i, i + max), '');
    }
  }
  if (cur) out.push(cur);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translateChunk(text, target, isCancelled) {
  if (!text.trim()) return text;
  for (let attempt = 0; ; attempt++) {
    if (isCancelled?.()) throw new Error('Cancelado');
    try {
      // Petición "simple" (form-urlencoded): sin preflight CORS y sin límite práctico de longitud de URL
      const res = await fetch(ENDPOINT + encodeURIComponent(target), { method: 'POST', body: new URLSearchParams({ q: text }) });
      if (res.ok) {
        const data = await res.json();
        const translated = (data?.[0] || []).map((s) => s?.[0] || '').join('');
        // Conserva los saltos de línea de los bordes, que el traductor a veces recorta
        const lead = text.match(/^\s*/)[0];
        const trail = text.match(/\s*$/)[0];
        return lead + translated.trim() + trail;
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`El traductor respondió ${res.status}`), { fatal: true });
    } catch (e) {
      if (e.fatal || attempt >= 6) throw e;
    }
    await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500); // 1 s, 2 s, 4 s… hasta 30 s
  }
}

/**
 * Traduce todas las páginas. Devuelve un array de textos traducidos (mismo orden que pages).
 * @param {Array<{text:string}>} pages
 * @param {string} target código de idioma destino
 * @param {{onProgress?:(done:number,total:number)=>void, isCancelled?:()=>boolean}} cb
 */
export async function translatePages(pages, target, cb = {}) {
  const jobs = [];
  pages.forEach((p, pi) => splitText(p?.text || '').forEach((chunk, ci) => jobs.push({ pi, ci, chunk })));
  const results = pages.map(() => []);
  let next = 0;
  let done = 0;
  cb.onProgress?.(0, jobs.length);
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results[job.pi][job.ci] = await translateChunk(job.chunk, target, cb.isCancelled);
      cb.onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return results.map((parts) => parts.join(''));
}
