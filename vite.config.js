import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // rutas relativas: se puede servir desde cualquier carpeta (GitHub Pages, Netlify, USB...)
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
});
