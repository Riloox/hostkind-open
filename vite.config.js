import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { transformSync } from 'esbuild';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The panel build the login screen reports. Read from package.json so it can
// never drift from the released version.
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// The dev server proxies to the panel on :2121. Browsers send an Origin
// header on POSTs and WS upgrades, and the panel's cross-origin defense
// (server.js originAllowed) rejects any Origin that isn't the panel's own
// loopback port or an allowedOrigins entry. Through the proxy the page's
// origin is http://localhost:5173 - a different port - so the panel would
// 403 the panel's own dev frontend. Strip the Origin so the panel sees the
// dev server as the non-browser client it is (absent Origin is allowed by
// design, same as curl); the real auth is the Bearer token anyway.
const stripOrigin = (proxy) => {
  proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
  proxy.on('proxyReqWs', (proxyReq) => proxyReq.removeHeader('origin'));
};

// Apply esbuild's CJS-to-ESM transform to our project-level CJS file
// (i18n.cjs) in the dev server. build.commonjsOptions below handles the
// production build; this plugin covers the dev path where the Rollup
// CJS plugin doesn't run.
const cjsToEsm = {
  name: 'cjs-to-esm',
  enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('.cjs')) {
      const r = transformSync(code, { format: 'esm', target: 'es2020', sourcefile: id });
      return { code: r.code, map: r.map };
    }
  },
};

export default defineConfig({
  plugins: [react(), cjsToEsm],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: true,
    commonjsOptions: {
      // i18n.cjs is shared with the Node backend as CommonJS, but the
      // frontend imports it from src/i18n/index.js. Tell Rollup's CJS
      // plugin to also process our source-level CJS file, not just deps.
      include: [/i18n\.cjs$/, /node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('uplot')) return 'charts';
          if (id.includes('@radix-ui')) return 'radix';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: {
      // SteamCMD writes locked temp files (libraryfolders.vdf.async*.tmp)
      // into resources/installers/steamcmd while installing/updating game
      // servers. Watching them crashes the Vite watcher with EBUSY on
      // Windows, so ignore that whole tree (files there never need HMR).
      ignored: [
        '**/resources/installers/steamcmd/**',
        '**/*.tmp',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:2121',
        configure: stripOrigin,
      },
      '/resources': {
        target: 'http://localhost:2121',
        configure: stripOrigin,
      },
      '/ws': {
        target: 'ws://localhost:2121',
        ws: true,
        configure: stripOrigin,
      },
    },
  },
});
