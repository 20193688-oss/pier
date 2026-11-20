/* Vite: the web app's dev server, build and unit tests.

   - `@/` resolves to `src/` (the same alias as tsconfig `paths`).
   - The dev server listens on `PORT` (default 3000: the API's default SIWE domain and web
     origin are http://localhost:3000, and the root `npm run dev:stack` passes PORT=3000).
   - Every `/v1/*` call and `/.well-known/*` (the API's stellar.toml, whose SEP-10 signing key the
     sign-in checks) is proxied to the API (the first of PEDOSPE_API_URL, API_URL, VITE_API_URL,
     PUBLIC_API_URL; default http://localhost:4000), so the browser talks to one origin and the
     API's HttpOnly session cookie works without cross-origin rules.
   - `--mode mock` (npm run dev:mock) serves every screen from the in-browser mock API and a demo
     wallet, with no backend and no browser wallet.
   - `virtual:openapi` is the API's committed OpenAPI document (`apps/api/openapi.json`) when it
     exists, else null: the docs' API reference renders from it.
   - The installable app: `/manifest.webmanifest` (named from src/lib/brand.ts, start_url /app)
     and `/sw.js` (pwa/sw.js, versioned per build), served in development and emitted by a
     build; index.html's `__BRAND__` is the product's name. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const OPENAPI_ID = 'virtual:openapi';
const OPENAPI_PATH =
  process.env.PEDOSPE_OPENAPI_PATH ||
  fileURLToPath(new URL('../api/openapi.json', import.meta.url));

function openapi(): Plugin {
  return {
    name: 'pedospe-openapi',
    resolveId: (id) => (id === OPENAPI_ID ? `\0${OPENAPI_ID}` : null),
    load(id) {
      if (id !== `\0${OPENAPI_ID}`) return null;
      if (!existsSync(OPENAPI_PATH)) return 'export default null;';
      this.addWatchFile(OPENAPI_PATH);
      return `export default ${readFileSync(OPENAPI_PATH, 'utf8')};`;
    },
  };
}

/** The product's name, read from src/lib/brand.ts (the one place it is written). */
function brand(): { name: string; shortName: string } {
  const text = readFileSync(fileURLToPath(new URL('./src/lib/brand.ts', import.meta.url)), 'utf8');
  const name = /name:\s*'([^']+)'/.exec(text)?.[1] ?? 'app';
  const shortName = /shortName:\s*'([^']+)'/.exec(text)?.[1] ?? name;
  return { name, shortName };
}

function manifest(): string {
  const b = brand();
  return JSON.stringify(
    {
      name: b.name,
      short_name: b.shortName,
      description: 'Dólares digitales: enviar, recibir, pagar con QR. / Digital dollars: send, receive, pay by QR.',
      lang: 'es',
      start_url: '/app',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f1f3ee',
      theme_color: '#f1f3ee',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
}

function pwa(): Plugin {
  const swSource = () =>
    readFileSync(fileURLToPath(new URL('./pwa/sw.js', import.meta.url)), 'utf8');
  return {
    name: 'pedospe-pwa',
    transformIndexHtml: (html) => html.replaceAll('__BRAND__', brand().name),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/manifest.webmanifest') {
          res.setHeader('Content-Type', 'application/manifest+json');
          return res.end(manifest());
        }
        if (req.url === '/sw.js') {
          res.setHeader('Content-Type', 'text/javascript');
          return res.end(swSource().replaceAll('__VERSION__', 'dev'));
        }
        next();
      });
    },
    generateBundle(_options, bundle) {
      // The version follows the build's own files: a new build is a new worker.
      const version = createHash('sha256')
        .update(Object.keys(bundle).sort().join(','))
        .digest('hex')
        .slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest() });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: swSource().replaceAll('__VERSION__', version),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiUrl =
    env.PEDOSPE_API_URL ||
    env.API_URL ||
    env.VITE_API_URL ||
    env.PUBLIC_API_URL ||
    'http://localhost:4000';
  const port = Number(env.PORT) || 3000;
  const mock = mode === 'mock' || env.VITE_MOCK === '1';
  const proxy = {
    '/v1': { target: apiUrl, changeOrigin: true },
    '/.well-known': { target: apiUrl, changeOrigin: true },
  };
  return {
    plugins: [react(), tailwindcss(), openapi(), pwa()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    define: {
      'import.meta.env.VITE_MOCK': JSON.stringify(mock ? '1' : ''),
    },
    server: {
      port,
      strictPort: true,
      proxy: mock ? undefined : proxy,
    },
    preview: {
      port,
      strictPort: true,
      proxy,
    },
    build: { target: 'es2022', sourcemap: true },
    test: {
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  };
});
