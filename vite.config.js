import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { transformSync } from 'esbuild';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The panel build the login screen reports. Read from package.json so it can
// never drift from the released version.
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// The backend port the dev proxy targets, from the shared resolver
// (scripts/resolve-port.cjs: FLEETDECK_PORT > LODESTONE_PORT >
// config.json panelPort > 2121). A hardcoded 2121 here used to break
// `start-dev` for anyone with a custom panelPort: Vite proxied to an empty
// port while the backend listened on the configured one.
const { resolvePanelPort } = require('./scripts/resolve-port.cjs');
const panelPort = resolvePanelPort();

// The dev server proxies to the panel (see panelPort above). Browsers send an Origin
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

// i18n.json holds every language (~120 kB each) and is shared with the
// backend. Importing it whole put all of them in the entry chunk. Instead the
// frontend imports `virtual:i18n`: the metadata plus the default language
// (always needed - it is the fallback for missing keys), and a loader per
// other language that Rollup splits into its own chunk.
const I18N_JSON = path.join(__dirname, 'i18n.json');
const I18N_ID = 'virtual:i18n';
const I18N_LANG_PREFIX = 'virtual:i18n/lang/';
const i18nSplit = {
  name: 'i18n-split',
  resolveId(id) {
    if (id === I18N_ID || id.startsWith(I18N_LANG_PREFIX)) return `\0${id}`;
  },
  load(id) {
    if (!id.startsWith(`\0${I18N_ID}`)) return;
    this.addWatchFile(I18N_JSON);
    const data = JSON.parse(readFileSync(I18N_JSON, 'utf8'));
    if (id.startsWith(`\0${I18N_LANG_PREFIX}`)) {
      const dict = data.dictionaries[id.slice(`\0${I18N_LANG_PREFIX}`.length)] || {};
      // JSON.parse of a string literal parses faster than an object literal.
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(dict))});`;
    }
    const loaders = data.SUPPORTED_LANGS
      .filter((lang) => lang !== data.DEFAULT_LANG)
      .map((lang) => `${JSON.stringify(lang)}: () => import(${JSON.stringify(I18N_LANG_PREFIX + lang)})`);
    return [
      `import defaultDictionary from ${JSON.stringify(I18N_LANG_PREFIX + data.DEFAULT_LANG)};`,
      `export const SUPPORTED_LANGS = ${JSON.stringify(data.SUPPORTED_LANGS)};`,
      `export const DEFAULT_LANG = ${JSON.stringify(data.DEFAULT_LANG)};`,
      `export const SPANISH_COUNTRIES = ${JSON.stringify(data.SPANISH_COUNTRIES)};`,
      'export { defaultDictionary };',
      `export const loaders = { ${loaders.join(', ')} };`,
    ].join('\n');
  },
};

export default defineConfig({
  plugins: [react(), cjsToEsm, i18nSplit],
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
          // Lazy views in src/views/* split automatically via React.lazy
          // dynamic imports — leave them alone (return undefined) so Rollup
          // emits one chunk per view plus a shared chunk. Forcing them into
          // coarse manual chunks caused circular-chunk warnings because views
          // cross-import each other (e.g. WorldsView -> TerrariaWorldsView,
          // MapView -> PalworldMapView) and eager GamesView must stay in the
          // entry chunk.
          if (id.includes('src/views/')) return undefined;
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
        target: `http://localhost:${panelPort}`,
        configure: stripOrigin,
      },
      '/resources': {
        target: `http://localhost:${panelPort}`,
        configure: stripOrigin,
      },
      '/ws': {
        target: `ws://localhost:${panelPort}`,
        ws: true,
        configure: stripOrigin,
      },
    },
  },
});
