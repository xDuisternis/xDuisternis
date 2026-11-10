# Duisternis OCR

Extrae el texto de **cualquier PDF (digital o escaneado) o imagen**. Gratis, sin límites y 100 % privado:
todo se procesa en el navegador con WebAssembly. No hay servidor, cuentas, cuotas ni marcas de agua.

## Qué hace

- **PDF digitales:** extrae la capa de texto al instante (sin OCR).
- **PDF escaneados, fotos y capturas:** OCR con Tesseract (motor LSTM) y enderezado automático de páginas torcidas.
- **PDF mixtos:** decide **página a página** si usar el texto digital o hacer OCR. También detecta texto con
  codificación rota (fuentes mal incrustadas) y aplica OCR en ese caso.
- **Sin límites:** procesa cualquier número de archivos y de páginas, de cualquier tamaño. Las páginas se reconocen en
  paralelo (un hilo por núcleo) y con contrapresión, así que la memoria no crece con el tamaño del PDF.
- **Idiomas incluidos:** español, inglés, portugués, francés, alemán, italiano y catalán (combinables).
- **Exporta a** TXT, Word (.docx), Markdown, JSON o **PDF buscable** (aspecto original con texto seleccionable),
  archivo por archivo o todo en un ZIP.
- Texto editable antes de exportar, búsqueda, copiar por página, pegar capturas con Ctrl+V y PDF con contraseña.
- Autoalojado: el worker de OCR, el núcleo WASM y los modelos de idioma se sirven desde la propia web (sin CDNs),
  así que funciona en redes restringidas y no depende de terceros.

Rendimiento de referencia (4 núcleos, 300 ppp): 60 páginas escaneadas en unos 21 s.

## Uso

```bash
npm install
npm run dev       # desarrollo en http://localhost:5173
npm run build     # genera la web estática en dist/
npm run preview   # sirve dist/ en local
```

`dist/` es una web estática: se puede subir a GitHub Pages, Netlify, Cloudflare Pages o cualquier hosting.
El workflow `.github/workflows/deploy.yml` la publica en GitHub Pages en cada push a `main`
(actívalo en *Settings → Pages → Source: GitHub Actions*).

## Añadir más idiomas

1. `npm i -D @tesseract.js-data/<código>` (por ejemplo `chi_sim`, `rus`, `ara`, `jpn`).
2. Añade `{ "code": "<código>", "name": "<Nombre>" }` a `src/langs.json`.
3. `npm run build`.

## Estructura

| Archivo | Función |
|---|---|
| `src/engine.js` | Extracción: texto nativo con PDF.js, rasterizado, pool de workers de Tesseract, decisión por página |
| `src/exporters.js` | TXT, Markdown, DOCX, JSON, PDF buscable (pdf-lib) y ZIP |
| `src/main.js` | Interfaz: cola de archivos, progreso, visor/editor, descargas |
| `scripts/vendor.mjs` | Copia a `public/vendor` el worker y núcleo WASM de Tesseract, los modelos y los recursos de PDF.js |

## Consejos de calidad

- Marca solo los idiomas que aparecen en el documento: es más rápido y preciso.
- Para letra muy pequeña o escaneos de baja calidad, usa la calidad «Máxima (400 ppp)».
- Si un PDF digital sale con caracteres raros, usa el modo «Forzar OCR».

Licencias: Tesseract.js (Apache-2.0), PDF.js (Apache-2.0), pdf-lib (MIT), docx (MIT), JSZip (MIT/GPLv3).
