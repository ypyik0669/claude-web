// The application proper, loaded after main.tsx has settled the interface language (the English catalogs are a
// separate chunk, see i18n/index.ts `loadEnglish`). Everything from here on may call `tr()` at module level.
import { openFileMenuAt } from '@/features/files/FileMenu';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { useStore } from './store';
import { COMPOSER_REACH, PLACE_CONTAINER, PLACE_OPENER } from './features/composer/reach';
import { tr } from '@/i18n';
import { startGeminiKeepalive } from '@/features/gateway/gemini-login';

export function boot(): void {
  useStore.getState().init();
  // the desktop shell reloaded this window after its page crashed or failed to load (desktop/src/main.ts `recover`)
  {
    const q = new URLSearchParams(location.search);
    if (q.has('recovered')) {
      q.delete('recovered');
      history.replaceState(history.state, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
      setTimeout(() => useStore.getState().toast(tr('页面出错，已恢复'), true), 1200);
    }
  }
  // Gemini web sessions die if the sidecar cannot renew its cookie: keep them alive while the app runs
  startGeminiKeepalive();
  (window as any).__store = useStore; // debugging aid
  (window as any).__openFileMenu = (p: string) => openFileMenuAt(p, 40, 40); // ui-smoke: the file menu without a file row on screen
  // where every control of the old composer went (the table reach.test.ts checks): ui-smoke opens each place
  (window as any).__cwComposerReach = { reach: COMPOSER_REACH, container: PLACE_CONTAINER, opener: PLACE_OPENER };
  // installable on phones (LAN access); the desktop shell and dev server skip it, and so does the app inside the
  // phone shell's iframe: the shell's own Service Worker serves app/ there, an app/sw.js would compete with it
  if ('serviceWorker' in navigator && !(window as any).desktop && location.protocol !== 'file:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => {});
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary area={tr('应用')} full>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
