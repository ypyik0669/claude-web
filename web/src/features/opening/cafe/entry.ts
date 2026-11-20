// The entry of dist/opening/cafe-opening.js (web/vite.opening.config.ts): what the opening page calls once the script
// has loaded (desktop/src/opening.ts `startCafe`).
import { startCafeOpening } from './cafe-opening';

(window as unknown as { cwCafeOpening: unknown }).cwCafeOpening = { start: startCafeOpening };
