// Exportación de resultados: TXT, Markdown, Word (.docx), JSON, PDF buscable y ZIP con todo.
import { Document, Packer, Paragraph, HeadingLevel, PageBreak, TextRun } from 'docx';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

export const baseName = (name) => name.replace(/\.[^.]+$/, '');

export function toTxt(result) {
  if (result.pages.length === 1) return result.pages[0].text + '\n';
  return result.pages.map((p) => `===== Página ${p.n} =====\n${p.text}`).join('\n\n') + '\n';
}

export function toMarkdown(result) {
  const head = `# ${baseName(result.name)}\n\n`;
  if (result.pages.length === 1) return head + result.pages[0].text + '\n';
  return head + result.pages.map((p) => `## Página ${p.n}\n\n${p.text}`).join('\n\n') + '\n';
}

export function toJson(result) {
  return JSON.stringify({
    archivo: result.name,
    paginas: result.pages.length,
    generado: new Date().toISOString(),
    resultado: result.pages.map((p) => ({ pagina: p.n, metodo: p.method === 'ocr' ? 'ocr' : 'texto-nativo', confianza: p.confidence, texto: p.text })),
  }, null, 2);
}

export async function toDocx(result) {
  const children = [new Paragraph({ text: baseName(result.name), heading: HeadingLevel.TITLE })];
  result.pages.forEach((p, i) => {
    if (result.pages.length > 1) {
      if (i > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new Paragraph({ text: `Página ${p.n}`, heading: HeadingLevel.HEADING_2 }));
    }
    // Un párrafo por bloque; los saltos simples se mantienen como saltos de línea
    for (const block of p.text.split(/\n{2,}/)) {
      const lines = block.split('\n');
      children.push(new Paragraph({
        children: lines.map((line, j) => new TextRun({ text: line, break: j > 0 ? 1 : 0 })),
      }));
    }
  });
  const doc = new Document({ creator: 'Duisternis OCR', title: baseName(result.name), sections: [{ children }] });
  return Packer.toBlob(doc);
}

/**
 * PDF buscable: las páginas con texto nativo se copian tal cual del original;
 * las escaneadas se sustituyen por imagen + capa de texto invisible generada por Tesseract.
 */
export async function toSearchablePdf(result) {
  const out = await PDFDocument.create();
  const original = result.sourceBytes ? await PDFDocument.load(result.sourceBytes, { ignoreEncryption: true }) : null;
  for (const part of result.pdfParts) {
    if (part.kind === 'native' && original) {
      const [pg] = await out.copyPages(original, [part.index]);
      out.addPage(pg);
    } else if (part.kind === 'ocr' && part.bytes) {
      const src = await PDFDocument.load(part.bytes);
      const pgs = await out.copyPages(src, src.getPageIndices());
      pgs.forEach((pg) => out.addPage(pg));
    }
  }
  out.setTitle(baseName(result.name));
  out.setProducer('Duisternis OCR');
  return new Blob([await out.save()], { type: 'application/pdf' });
}

export const FORMATS = {
  txt: { label: 'Texto (.txt)', ext: 'txt', make: async (r) => new Blob([toTxt(r)], { type: 'text/plain;charset=utf-8' }) },
  md: { label: 'Markdown (.md)', ext: 'md', make: async (r) => new Blob([toMarkdown(r)], { type: 'text/markdown;charset=utf-8' }) },
  docx: { label: 'Word (.docx)', ext: 'docx', make: toDocx },
  json: { label: 'JSON (.json)', ext: 'json', make: async (r) => new Blob([toJson(r)], { type: 'application/json' }) },
  pdf: { label: 'PDF buscable (.pdf)', ext: 'pdf', make: toSearchablePdf, needs: (r) => !!r.pdfParts },
};

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

export async function exportOne(result, fmt) {
  const f = FORMATS[fmt];
  download(await f.make(result), `${baseName(result.name)}${fmt === 'pdf' ? '_ocr' : ''}.${f.ext}`);
}

export async function exportZip(results, fmt) {
  const zip = new JSZip();
  const used = new Set();
  for (const r of results) {
    const f = FORMATS[fmt];
    if (f.needs && !f.needs(r)) continue;
    let name = `${baseName(r.name)}${fmt === 'pdf' ? '_ocr' : ''}.${f.ext}`;
    for (let i = 2; used.has(name); i++) name = `${baseName(r.name)} (${i}).${f.ext}`;
    used.add(name);
    zip.file(name, await f.make(r));
  }
  download(await zip.generateAsync({ type: 'blob' }), `ocr_${fmt}_${new Date().toISOString().slice(0, 10)}.zip`);
}
