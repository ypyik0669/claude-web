import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appUrl } from './app-url';

describe('appUrl', () => {
  it('a root-absolute server path becomes relative to the page', () => {
    expect(appUrl('/api/file?x=1')).toBe('api/file?x=1');
  });
  it('a path that is already relative is returned as is', () => {
    expect(appUrl('api/file?x=1')).toBe('api/file?x=1');
  });
});

const SRC = path.resolve(__dirname, '..');
const sources = (dir = SRC, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

// the phone shell opens the app at app/index.html and serves app/api/… through the tunnel:
// a '/api/…' literal would leave the shell's folder and miss the computer
describe('no root-absolute /api/ URL in the web app', () => {
  it("no non-test source has a string literal that starts with '/api/ or `/api/", () => {
    const bad: string[] = [];
    for (const p of sources()) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (/['"`]\/api\//.test(line)) bad.push(`${path.relative(SRC, p)}:${i + 1}`); });
    }
    expect(bad).toEqual([]);
  });

  // the same for the other server paths the app loads (spec §6), and in index.html / public/*.js too
  it('no root-absolute api, ws, sw.js, manifest or icon path in the sources, index.html or public scripts', () => {
    const ROOT_PATH = /['"`(]\/(?:api\b|ws\b|sw\.js|manifest\.webmanifest|icon[-.])/;
    const web = path.resolve(SRC, '..');
    const files = [...sources(), path.join(web, 'index.html'), ...fs.readdirSync(path.join(web, 'public')).filter((n) => n.endsWith('.js')).map((n) => path.join(web, 'public', n))];
    const bad: string[] = [];
    for (const p of files) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (ROOT_PATH.test(line)) bad.push(`${path.relative(SRC, p)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
