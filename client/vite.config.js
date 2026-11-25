import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// Vendor chunking: long-lived third-party code is split out of the app chunks
// so it caches across releases and the entry chunk stays small.
function manualChunks(id) {
  if (!id.includes('node_modules')) return undefined;
  if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\//.test(id)) return 'vendor-react';
  if (/node_modules\/three\//.test(id)) return 'vendor-three';
  if (/node_modules\/uplot\//.test(id)) return 'vendor-charts';
  if (/node_modules\/(d3-[a-z-]+|internmap|delaunator|robust-predicates)\//.test(id)) return 'vendor-d3';
  if (/node_modules\/(framer-motion|motion-dom|motion-utils)\//.test(id)) return 'vendor-motion';
  if (/node_modules\/(socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser|@socket\.io)\//.test(id)) return 'vendor-socket';
  if (/node_modules\/(zustand|clsx|react-hot-toast|goober|date-fns)\//.test(id)) return 'vendor-misc';
  return undefined;
}

// Virtual module with every Lucide icon's raw IconNode (kebab-name -> node), built
// from lucide-react's own icon modules so the canvas renderer and the React
// components share ONE icon package. Alias modules (renamed icons) re-export
// another icon and have no `__iconNode`, so only canonical files are imported;
// that keeps the lazy full-library chunk to the node data alone.
const ICON_NODES_ID = 'virtual:lucide-icon-nodes';
function lucideIconNodes() {
  return {
    name: 'lucide-icon-nodes',
    resolveId: (id) => (id === ICON_NODES_ID ? `\0${ICON_NODES_ID}` : null),
    load(id) {
      if (id !== `\0${ICON_NODES_ID}`) return null;
      const dir = path.resolve(__dirname, 'node_modules/lucide-react/dist/esm/icons');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && fs.readFileSync(path.join(dir, f), 'utf8').includes('const __iconNode'));
      const imports = files.map((f, i) => `import { __iconNode as i${i} } from 'lucide-react/dist/esm/icons/${f}';`);
      const entries = files.map((f, i) => `  ${JSON.stringify(f.slice(0, -4))}: i${i}`);
      return `${imports.join('\n')}\nexport default {\n${entries.join(',\n')}\n};\n`;
    }
  };
}

export default defineConfig({
  plugins: [react(), lucideIconNodes()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/metrics': { target: 'http://localhost:5000', changeOrigin: true },
      '/health': { target: 'http://localhost:5000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:5000', ws: true, changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // three.js (~540 kB minified) is intentionally its own lazy chunk, only
    // fetched when the 3D graph is opened.
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { manualChunks } }
  },
  test: {
    environment: 'node',
    // Playwright specs (e2e/) run under `npm run e2e`, not Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    setupFiles: './src/test/setup.js'
  }
});
