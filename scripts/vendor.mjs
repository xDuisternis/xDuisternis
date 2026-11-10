// Copia al directorio public/vendor todo lo que el OCR necesita en tiempo de ejecución
// (worker de Tesseract, núcleo WebAssembly, modelos de idioma y recursos de PDF.js),
// para que la app funcione 100 % autoalojada, sin CDNs ni servidores de terceros.
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(root, 'public', 'vendor');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'lang'), { recursive: true });

// Tesseract.js: worker + núcleo WASM (todas las variantes; la librería elige la mejor según el navegador)
cpSync(join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), join(out, 'tesseract', 'worker.min.js'));
const core = pkgDir('tesseract.js-core');
mkdirSync(join(out, 'core'), { recursive: true });
for (const f of ['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  if (existsSync(join(core, f))) cpSync(join(core, f), join(out, 'core', f));
}

// Modelos de idioma (versión "best_int": precisión LSTM alta y rápida)
const langs = JSON.parse(readFileSync(join(root, 'src', 'langs.json'), 'utf8'));
for (const { code } of langs) {
  const dir = pkgDir(`@tesseract.js-data/${code}`);
  const src = [join(dir, '4.0.0_best_int', `${code}.traineddata.gz`), join(dir, '4.0.0', `${code}.traineddata.gz`)]
    .find(existsSync);
  if (!src) throw new Error(`No se encontró el modelo de idioma "${code}"`);
  cpSync(src, join(out, 'lang', `${code}.traineddata.gz`));
}

// PDF.js: cmaps (CJK y codificaciones raras), fuentes estándar y decodificadores WASM (JPEG2000 en escaneos)
const pdfjs = pkgDir('pdfjs-dist');
for (const d of ['cmaps', 'standard_fonts', 'wasm']) cpSync(join(pdfjs, d), join(out, 'pdfjs', d), { recursive: true });

console.log(`vendor listo: ${langs.length} idiomas copiados a public/vendor`);
