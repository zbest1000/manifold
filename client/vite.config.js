import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

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

export default defineConfig({
  plugins: [react()],
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
    setupFiles: './src/test/setup.js'
  }
});
