// Which macOS a Mach-O binary was built for (its "minos"), for the macOS-12 checks of the mac release jobs
// (scripts/mac/check-min-os.mjs, scripts/mac/build-datachannel.sh). Pure: the file is read through `read(offset,
// length)`, so the tests hand in buffers. Tests: server/src/app/mac-min-os.test.ts.
//
// A minos above the target is not by itself proof a binary will not load (dyld does not check it for a dlopen'd
// module: node-datachannel's x64 build says 26.0 and loads on macOS 15), but a binary built for the target never
// carries one above it — and the imports of one built for later can be what stops it (docs/notes/macos-ci.md).

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
/** Load commands are read from the first this-many bytes of a slice (they sit right after the header). */
const HEAD = 256 * 1024;

const CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'x86', 12: 'arm' };

/** A packed X.Y.Z (16.8.8 bits) as text: 0x000c0000 → "12.0.0". */
export function versionText(v) {
  return `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

/** -1 / 0 / 1 for dotted versions ("12.0" vs "12.0.0" are equal). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** One thin Mach-O at `offset`: its CPU and the macOS it needs (null when it says nothing). Null when not a Mach-O. */
function thinSlice(read, offset) {
  const b = read(offset, HEAD);
  if (b.length < 32) return null;
  const magic = b.readUInt32LE(0);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return null;
  const cpu = CPU[b.readUInt32LE(4)] ?? `cpu-${b.readUInt32LE(4).toString(16)}`;
  const ncmds = b.readUInt32LE(16);
  let o = magic === MH_MAGIC_64 ? 32 : 28;
  for (let i = 0; i < ncmds && o + 8 <= b.length; i++) {
    const cmd = b.readUInt32LE(o);
    const size = b.readUInt32LE(o + 4);
    if (cmd === LC_BUILD_VERSION && o + 16 <= b.length) {
      if (b.readUInt32LE(o + 8) === PLATFORM_MACOS) return { cpu, minos: versionText(b.readUInt32LE(o + 12)) };
    } else if (cmd === LC_VERSION_MIN_MACOSX && o + 12 <= b.length) {
      return { cpu, minos: versionText(b.readUInt32LE(o + 8)) };
    }
    if (size < 8) break;
    o += size;
  }
  return { cpu, minos: null };
}

/**
 * The slices of a Mach-O file (one for a thin binary, one per architecture for a universal one), or null when the
 * file is not a Mach-O. `read(offset, length)` returns at most `length` bytes from `offset`.
 */
export function machoSlices(read) {
  const h = read(0, 4096);
  if (h.length < 8) return null;
  const be = h.readUInt32BE(0);
  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const n = h.readUInt32BE(4);
    // a Java class file starts with 0xcafebabe too: its "count" is a version number in the 40s and up
    if (n === 0 || n > 16) return null;
    const step = be === FAT_MAGIC_64 ? 32 : 20;
    const out = [];
    for (let i = 0; i < n; i++) {
      const e = 8 + i * step;
      if (e + step > h.length) return null;
      const off = be === FAT_MAGIC_64 ? Number(h.readBigUInt64BE(e + 8)) : h.readUInt32BE(e + 8);
      const s = thinSlice(read, off);
      if (s) out.push(s);
    }
    return out.length ? out : null;
  }
  const s = thinSlice(read, 0);
  return s ? [s] : null;
}

const GO_BUILDINFO = Buffer.from('\xff Go buildinf:', 'latin1');

/**
 * The Go release a Go binary was built with ("1.26.10"), from its build info (`\xff Go buildinf:`, then pointer
 * size and flags; flag 2 = the version string follows inline at +32, uvarint-length-prefixed — Go 1.18+). Null for
 * anything else. Go's own floor moves with its releases: Go 1.26 is the last that runs on macOS 12.
 */
export function goVersionOf(buf) {
  const at = buf.indexOf(GO_BUILDINFO);
  if (at < 0 || at + 33 > buf.length) return null;
  if (!(buf[at + 15] & 2)) return null;
  let len = 0;
  let shift = 0;
  let p = at + 32;
  for (; p < buf.length && shift < 35; p++, shift += 7) {
    len |= (buf[p] & 0x7f) << shift;
    if (!(buf[p] & 0x80)) { p++; break; }
  }
  const m = /^go(\d+\.\d+(?:\.\d+)?)/.exec(buf.toString('latin1', p, Math.min(buf.length, p + len)));
  return m ? m[1] : null;
}

/**
 * The verdict over a set of binaries: `bad` = needs a macOS above `max` and no `allow` pattern matches its path, or
 * is a Go binary from a Go release past `goMax` (allowed or not: Go itself stops running on that macOS); `allowed` =
 * above `max` but on the allow list (with the pattern that let it through); `ok` = the count of the rest. A slice
 * that names no minimum is counted ok (old toolchains: only the platform default, far below 12).
 */
export function judgeMinOs(binaries, max, allow = [], goMax = null) {
  const bad = [];
  const allowed = [];
  let ok = 0;
  for (const { path, slices, go } of binaries) {
    if (go && goMax && compareVersions(go.split('.').slice(0, 2).join('.'), goMax) > 0) {
      bad.push({ path, why: `Go ${go} (Go after ${goMax} does not run on macOS ${max})` });
      continue;
    }
    const over = slices.filter((s) => s.minos && compareVersions(s.minos, max) > 0);
    if (!over.length) { ok++; continue; }
    const why = over.map((s) => `${s.cpu} ${s.minos}`).join(', ') + (go ? ` · Go ${go}` : '');
    const rule = allow.find((re) => re.test(path.replace(/\\/g, '/')));
    if (rule) allowed.push({ path, why, rule: String(rule) });
    else bad.push({ path, why });
  }
  return { bad, allowed, ok };
}
