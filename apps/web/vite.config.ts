/* Vite: the web app's dev server (port 4321), build and unit tests.

   - `@/` resolves to `src/` (the same alias as tsconfig `paths`).
   - In development every `/v1/*` call is proxied to the API (`PEDOSPE_API_URL`, default
     http://localhost:4000), so the browser talks to one origin and the API's HttpOnly session
     cookie works without cross-origin rules.
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
const OPENAPI_PATH = fileURLToPath(new URL('../api/openapi.json', import.meta.url));

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
  const apiUrl = env.PEDOSPE_API_URL || 'http://localhost:4000';
  const mock = mode === 'mock' || env.VITE_MOCK === '1';
  return {
    plugins: [react(), tailwindcss(), openapi()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    define: {
      'import.meta.env.VITE_MOCK': JSON.stringify(mock ? '1' : ''),
    },
    server: {
      port: 4321,
      strictPort: true,
      proxy: mock ? undefined : { '/v1': { target: apiUrl, changeOrigin: true } },
    },
    preview: {
      port: 4321,
      strictPort: true,
      proxy: { '/v1': { target: apiUrl, changeOrigin: true } },
    },
    build: { target: 'es2022', sourcemap: true },
    test: {
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  };
});
