import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { useStore } from './store';
import { COMPOSER_REACH, PLACE_CONTAINER, PLACE_OPENER } from './features/composer/reach';
import { tunnelHost } from './ws/tunnel';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './fonts.css';
import './styles.css';
import './styles/chat.css';
import './styles/composer.css';
import './styles/floating.css';
import './styles/extras.css';
import './styles/review-phone.css';
import './styles/phone.css';
import './styles/phone-sheet.css';
import './styles/phone-menus.css';
import './styles/rail.css';
import './styles/corners.css';

document.documentElement.dataset.theme = useStore.getState().theme;
if ((window as any).desktop) document.documentElement.classList.add('desktop');
useStore.getState().init();
(window as any).__store = useStore; // debugging aid
// where every control of the old composer went (the table reach.test.ts checks): ui-smoke opens each place
(window as any).__cwComposerReach = { reach: COMPOSER_REACH, container: PLACE_CONTAINER, opener: PLACE_OPENER };
// installable on phones (LAN access); the desktop shell and dev server skip it, and so does the app inside the
// phone shell's iframe: the shell's own Service Worker serves app/ there, an app/sw.js would compete with it
if ('serviceWorker' in navigator && !(window as any).desktop && !tunnelHost() && location.protocol !== 'file:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => {});
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary area="应用" full>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
