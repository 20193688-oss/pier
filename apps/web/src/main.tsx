/* The web app's entry: mock mode installs its API and demo wallet first, then the app renders. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.css';
import { MOCK } from '@/lib/env';
import { App } from '@/app/App';

async function start() {
  if (MOCK) {
    const { installMock } = await import('@/lib/mock');
    installMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
