import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './fonts.css';
import './styles.css';
import './styles/chat.css';
import './styles/composer.css';
import './styles/floating.css';
import './styles/extras.css';
import './styles/scroll-fade.css';
import './styles/review-phone.css';
import './styles/phone.css';
import './styles/phone-sheet.css';
import './styles/phone-menus.css';
import './styles/rail.css';
import './styles/background.css';
import './styles/background-page.css';
import './styles/cafe.css';
import './styles/corners.css';
import './styles/gateway.css';
import './styles/gateway-sources.css';
import './styles/hub.css';
import './styles/bots.css';
import { loadEnglish } from '@/i18n';

// The page's first paint: theme, the desktop flag, the styles above. Nothing reached from this file calls `tr()` —
// the store (and with it every table whose labels are built at module level, ui/terms.ts among them) waits for
// boot.tsx, after the English catalogs are in. The theme is read the way the store reads it (ui-settings.ts
// `resolveTheme`: the cached choice, else the system's), so the first paint does not flash the wrong one.
try {
  const cached = localStorage.getItem('cw.theme');
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = cached || (dark ? 'dark' : 'light');
} catch { /* storage blocked: the store sets it again once the settings arrive */ }
if ((window as any).desktop) document.documentElement.classList.add('desktop');

// The English catalogs are ~420 KB of source; a Chinese page (the default on a Chinese machine) never needs them,
// so they are their own chunk, loaded before any module that calls `tr()` at the top level gets to run (boot.tsx).
// A failed load leaves the interface Chinese rather than blank.
void loadEnglish()
  .catch(() => { /* English texts missing: the Chinese source text is shown */ })
  .then(() => import('./boot'))
  .then((m) => m.boot());
