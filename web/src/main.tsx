import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { useStore } from './store';
import './styles.css';

document.documentElement.dataset.theme = useStore.getState().theme;
if ((window as any).desktop) document.documentElement.classList.add('desktop');
useStore.getState().init();
(window as any).__store = useStore; // debugging aid
// installable on phones (LAN access); the desktop shell and dev server skip it
if ('serviceWorker' in navigator && !(window as any).desktop && location.protocol !== 'file:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register('/sw.js').catch(() => {});
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary area="应用" full>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
