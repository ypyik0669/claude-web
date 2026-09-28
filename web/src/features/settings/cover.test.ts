import { describe, expect, it } from 'vitest';
import { aboveCover } from './cover';

describe('coverApp: which siblings stay usable while the settings page (z-index 50) covers the app', () => {
  it('fixed layers stacked above it stay (dialogs 200, palette 55, toasts 60); everything else goes inert', () => {
    expect(aboveCover('fixed', '200', 50)).toBe(true);
    expect(aboveCover('fixed', '55', 50)).toBe(true);
    expect(aboveCover('fixed', '60', 50)).toBe(true);
    // the workbench, sidebar, right panel; a modal at the same level (shortcuts) is under the page
    expect(aboveCover('static', 'auto', 50)).toBe(false);
    expect(aboveCover('relative', '5', 50)).toBe(false);
    expect(aboveCover('fixed', '50', 50)).toBe(false);
    expect(aboveCover('fixed', 'auto', 50)).toBe(false);
    // a high z-index that is not a window layer (inside the page flow) is not an exception
    expect(aboveCover('absolute', '1000', 50)).toBe(false);
  });
});
