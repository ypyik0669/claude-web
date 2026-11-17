import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { describe, expect, it } from 'vitest';

// The desktop installer ships the ROOT package.json's dependencies (electron-builder.yml `files: package.json`), not
// server/package.json's. v0.2.7 added `yaml` only to the server's and every install died at start with
// ERR_MODULE_NOT_FOUND. The packaged smoke test missed it: dist-desktop/ sits inside the repo, so Node's lookup walked
// up into the repo's own node_modules.
const ROOT = path.resolve(__dirname, '../../..');
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const rootDeps: Record<string, string> = readJson('package.json').dependencies;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}
/** Packages the server loads at run time: value imports (not `import type`), static or dynamic. */
function runtimePackages(src: string): string[] {
  const out: string[] = [];
  // `(?<![\w.$])import(`: a dynamic import, not a method of that name (`ObjC.import('Quartz')` in a JXA script string)
  const re = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^'"`;]*?from\s*['"]([^'"]+)['"]|(?<![\w.$])import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('@shared')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (builtinModules.includes(name)) continue;
    out.push(name);
  }
  return out;
}

describe('packaging', () => {
  it("every server dependency is in the root package.json (the one the installer ships)", () => {
    const serverDeps: Record<string, string> = readJson('server/package.json').dependencies ?? {};
    expect(Object.keys(serverDeps).filter((d) => !(d in rootDeps))).toEqual([]);
  });
  it('every package the server imports at run time is a root dependency', () => {
    const missing = new Set<string>();
    for (const f of sourceFiles(path.join(ROOT, 'server', 'src'))) {
      for (const name of runtimePackages(fs.readFileSync(f, 'utf8'))) if (!(name in rootDeps)) missing.add(`${name} (${path.relative(ROOT, f)})`);
    }
    expect([...missing]).toEqual([]);
  });
});
