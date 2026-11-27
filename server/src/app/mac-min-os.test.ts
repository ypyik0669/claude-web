// The Mach-O reader behind the mac release jobs' macOS-12 checks (scripts/mac/macho.mjs, check-min-os.mjs).
import { describe, expect, it } from 'vitest';
import { compareVersions, goVersionOf, judgeMinOs, machoSlices, versionText } from '../../../scripts/mac/macho.mjs';

const ver = (s: string) => { const [a, b = 0, c = 0] = s.split('.').map(Number); return (a << 16) | (b << 8) | c; };

/** A thin 64-bit Mach-O: header + the given load commands (each [cmd, ...uint32 payload]). */
function thin(cpu: number, cmds: number[][]): Buffer {
  const body = cmds.map(([cmd, ...rest]) => {
    const b = Buffer.alloc(8 + rest.length * 4);
    b.writeUInt32LE(cmd, 0); b.writeUInt32LE(b.length, 4);
    rest.forEach((v, i) => b.writeUInt32LE(v >>> 0, 8 + i * 4));
    return b;
  });
  const h = Buffer.alloc(32);
  h.writeUInt32LE(0xfeedfacf, 0); h.writeUInt32LE(cpu, 4); h.writeUInt32LE(cmds.length, 16);
  h.writeUInt32LE(body.reduce((n, b) => n + b.length, 0), 20);
  return Buffer.concat([h, ...body]);
}
const X64 = 0x01000007, ARM64 = 0x0100000c;
const buildVersion = (minos: string, platform = 1) => [0x32, platform, ver(minos), ver('26.0'), 0];
const versionMin = (minos: string) => [0x24, ver(minos), ver('11.0')];
const segment = [0x19, 0, 0, 0, 0]; // something before the version command

/** A universal file holding the given slices (page-aligned like lipo's). */
function fat(slices: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  const h = Buffer.alloc(8 + slices.length * 20);
  h.writeUInt32BE(0xcafebabe, 0); h.writeUInt32BE(slices.length, 4);
  let off = 4096;
  slices.forEach((s, i) => {
    const e = 8 + i * 20;
    h.writeUInt32BE(s.readUInt32LE(4), e); h.writeUInt32BE(off, e + 8); h.writeUInt32BE(s.length, e + 12);
    off += Math.ceil(s.length / 4096) * 4096;
  });
  parts.push(Buffer.concat([h, Buffer.alloc(4096 - h.length)]));
  for (const s of slices) parts.push(Buffer.concat([s, Buffer.alloc(Math.ceil(s.length / 4096) * 4096 - s.length)]));
  return Buffer.concat(parts);
}
const reader = (b: Buffer) => (offset: number, length: number) => b.subarray(offset, offset + length);

describe('machoSlices: the macOS a binary was built for', () => {
  it('LC_BUILD_VERSION after other commands (node-datachannel x64 from npm: 26.0)', () => {
    expect(machoSlices(reader(thin(X64, [segment, buildVersion('26.0')])))).toEqual([{ cpu: 'x64', minos: '26.0.0' }]);
  });
  it('the older LC_VERSION_MIN_MACOSX (node-pty x64: 10.7)', () => {
    expect(machoSlices(reader(thin(X64, [versionMin('10.7')])))).toEqual([{ cpu: 'x64', minos: '10.7.0' }]);
  });
  it('a build version for another platform (iOS) is not a macOS minimum', () => {
    expect(machoSlices(reader(thin(ARM64, [buildVersion('17.0', 2)])))).toEqual([{ cpu: 'arm64', minos: null }]);
  });
  it('a universal file: every slice', () => {
    const f = fat([thin(X64, [buildVersion('12.0')]), thin(ARM64, [segment, buildVersion('12.3.1')])]);
    expect(machoSlices(reader(f))).toEqual([{ cpu: 'x64', minos: '12.0.0' }, { cpu: 'arm64', minos: '12.3.1' }]);
  });
  it('not a Mach-O: text, a Java class (0xcafebabe too), something too short', () => {
    expect(machoSlices(reader(Buffer.from('#!/bin/sh\necho hi\n'.repeat(4))))).toBeNull();
    const cls = Buffer.alloc(64); cls.writeUInt32BE(0xcafebabe, 0); cls.writeUInt32BE(0x00000041, 4); // major 65
    expect(machoSlices(reader(cls))).toBeNull();
    expect(machoSlices(reader(Buffer.alloc(4)))).toBeNull();
  });
});

describe('judgeMinOs: what may ship for macOS 12', () => {
  const bin = (path: string, ...minos: (string | null)[]) => ({ path, slices: minos.map((m) => ({ cpu: 'x64', minos: m })) });
  it('above the target is too new unless allowed; at or below it, or saying nothing, is fine', () => {
    const v = judgeMinOs([
      bin('Contents/Frameworks/Electron Framework', '12.0.0'),
      bin('app.asar.unpacked/node_modules/@node-datachannel/darwin-x64/node_datachannel.node', '26.0.0'),
      bin('app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude', '13.0.0'),
      bin('old.dylib', null),
      bin('pty.node', '10.7.0'),
    ], '12.0', [/claude-agent-sdk-darwin-[^/]+\/claude$/]);
    expect(v.ok).toBe(3);
    expect(v.bad).toEqual([{ path: 'app.asar.unpacked/node_modules/@node-datachannel/darwin-x64/node_datachannel.node', why: 'x64 26.0.0' }]);
    expect(v.allowed.map((a) => a.path)).toEqual(['app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude']);
  });
  it('allow patterns see forward slashes on Windows paths too', () => {
    expect(judgeMinOs([bin('a\\claude-agent-sdk-darwin-arm64\\claude', '13.0.0')], '12.0', [/claude-agent-sdk-darwin-[^/]+\/claude$/]).bad).toEqual([]);
  });
});

describe('Go binaries: Go 1.26 is the last release that runs on macOS 12', () => {
  /** Go 1.18+ build info: magic, pointer size, flags (2 = inline strings), padding to 32, uvarint length + version. */
  const buildinfo = (version: string, flags = 2) => {
    const h = Buffer.alloc(32);
    Buffer.from('\xff Go buildinf:', 'latin1').copy(h, 0);
    h[14] = 8; h[15] = flags;
    return Buffer.concat([Buffer.alloc(100, 7), h, Buffer.from([version.length]), Buffer.from(version), Buffer.from([40]), Buffer.from('path\tgithub.com/x/y\n')]);
  };
  it('the version from the build info (CLIProxyAPI v8.0.45: go1.26.10)', () => {
    expect(goVersionOf(buildinfo('go1.26.10'))).toBe('1.26.10');
    expect(goVersionOf(buildinfo('go1.27'))).toBe('1.27');
  });
  it('no build info, or the pre-1.18 pointer form: null', () => {
    expect(goVersionOf(Buffer.from('just a C program'))).toBeNull();
    expect(goVersionOf(buildinfo('go1.17', 0))).toBeNull();
  });
  it('a Go release past goMax is too new even when allowed; at goMax the allow list decides', () => {
    const cpa = (go: string) => ({ path: 'engines/darwin-arm64/cliproxyapi/cli-proxy-api', slices: [{ cpu: 'arm64', minos: '15.0.0' }], go });
    const allow = [/cliproxyapi\/cli-proxy-api$/];
    expect(judgeMinOs([cpa('1.26.10')], '12.0', allow, '1.26')).toMatchObject({ bad: [], allowed: [{ why: 'arm64 15.0.0 · Go 1.26.10' }] });
    expect(judgeMinOs([cpa('1.27.1')], '12.0', allow, '1.26').bad).toEqual([{ path: 'engines/darwin-arm64/cliproxyapi/cli-proxy-api', why: 'Go 1.27.1 (Go after 1.26 does not run on macOS 12.0)' }]);
  });
});

describe('versions', () => {
  it('packed and compared', () => {
    expect(versionText(ver('12.3.1'))).toBe('12.3.1');
    expect(compareVersions('12.0', '12.0.0')).toBe(0);
    expect(compareVersions('12.3', '12.10')).toBe(-1);
    expect(compareVersions('26.0.0', '12.0')).toBe(1);
  });
});
