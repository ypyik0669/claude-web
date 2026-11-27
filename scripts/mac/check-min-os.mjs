#!/usr/bin/env node
// Every Mach-O under a path must run on the oldest macOS we ship for (2026-11-27: macOS 12, the mac build is on
// Electron 43 for it). Used by the mac release jobs on the packaged .app, and by build-datachannel.sh on its output.
//
//   node scripts/mac/check-min-os.mjs <path…> --max 12.0 [--allow <regex>]… [--go-max 1.26]
//
// Prints each binary that needs more than --max; exits 1 when one of them is not on the allow list, or when a Go
// binary comes from a Go release after --go-max (allowed or not — Go 1.27 needs macOS 13). Symlinks are not followed
// (an .app's frameworks are full of them; the real file is walked once).

import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';
import { goVersionOf, judgeMinOs, machoSlices } from './macho.mjs';

const args = process.argv.slice(2);
const roots = [];
const allow = [];
let max = '12.0';
let goMax = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') max = args[++i];
  else if (args[i] === '--allow') allow.push(new RegExp(args[++i]));
  else if (args[i] === '--go-max') goMax = args[++i];
  else roots.push(args[i]);
}
if (!roots.length) {
  console.error('usage: check-min-os.mjs <path…> --max 12.0 [--allow <regex>]… [--go-max 1.26]');
  process.exit(2);
}

function* files(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const n of readdirSync(p)) yield* files(join(p, n));
  else if (st.isFile() && st.size >= 32) yield { path: p, size: st.size };
}

/** A Go binary's release (macho.mjs goVersionOf), looked for in 8 MB steps so a 200 MB framework is not read at once. */
function goVersion(read, size) {
  const STEP = 8 * 1024 * 1024;
  for (let off = 0; off < size; off += STEP) {
    const b = read(off, STEP + 64);
    const at = b.indexOf('\xff Go buildinf:', 0, 'latin1');
    if (at >= 0) return goVersionOf(read(off + at, 512));
  }
  return null;
}

const binaries = [];
for (const root of roots) {
  for (const f of files(root)) {
    const fd = openSync(f.path, 'r');
    try {
      const read = (offset, length) => {
        const n = Math.max(0, Math.min(length, f.size - offset));
        const b = Buffer.alloc(n);
        if (n) readSync(fd, b, 0, n, offset);
        return b;
      };
      const slices = machoSlices(read);
      if (slices) binaries.push({ path: relative(process.cwd(), f.path) || f.path, slices, go: goMax ? goVersion(read, f.size) : null });
    } finally {
      closeSync(fd);
    }
  }
}

const { bad, allowed, ok } = judgeMinOs(binaries, max, allow, goMax);
for (const a of allowed) console.log(`allowed  ${a.path}: ${a.why} (${a.rule})`);
for (const b of bad) console.log(`TOO NEW  ${b.path}: ${b.why}`);
console.log(`${binaries.length} Mach-O files: ${ok} run on macOS ${max}, ${allowed.length} allowed above it, ${bad.length} too new`);
process.exit(bad.length ? 1 : 0);
