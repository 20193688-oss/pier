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
     exists, else null: the docs' API reference renders from it. */
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
    plugins: [react(), tailwindcss(), openapi()],
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
