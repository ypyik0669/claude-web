import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { DialError } from '@anywhere';
import { explainDial, explainLinkEnd, explainPcError, noRtc, relayStatus, SAY, withRaw } from './explain';

// spec §10, verbatim
const PC_SILENT = '电脑没有回应：电脑可能关机、睡眠，或 Claude Web 没在运行。';
const NO_BROKER = '连不上牵线服务器：这个网络可能拦了，换个网络试试。';
const RELAY = '直连没打通，已改用慢速转发：文字能用，文件预览和上传不能用。';
const UNREACHABLE = '连不上。可以先用 IM 机器人（设置 → IM 机器人）。';

describe('explain: the spec §10 sentences, with the raw text kept as 原文', () => {
  it('pc-silent', () => {
    expect(explainDial(new DialError('pc-silent', 'no answer from the PC within 15000 ms'))).toEqual({ text: PC_SILENT, raw: 'no answer from the PC within 15000 ms' });
  });

  it('no-broker', () => {
    expect(explainDial(new DialError('no-broker', 'no signaling broker could be reached'))).toEqual({ text: NO_BROKER, raw: 'no signaling broker could be reached' });
  });

  it('unreachable, and anything that is not a dial error', () => {
    expect(explainDial(new DialError('unreachable', 'the slow relay could not be opened: x'))).toEqual({ text: UNREACHABLE, raw: 'the slow relay could not be opened: x' });
    expect(explainDial(new Error('boom'))).toEqual({ text: UNREACHABLE, raw: 'boom' });
    expect(explainDial('plain')).toEqual({ text: UNREACHABLE, raw: 'plain' });
  });

  it('the slow relay is a status line, not an error', () => {
    expect(relayStatus()).toBe(RELAY);
    expect(SAY.relay).toBe(RELAY);
  });

  it('a browser without RTCPeerConnection: the unreachable sentence, 原文 says why', () => {
    expect(noRtc()).toEqual({ text: UNREACHABLE, raw: 'RTCPeerConnection missing' });
  });

  it('withRaw puts the original after the sentence (none when there is nothing to add)', () => {
    expect(withRaw({ text: PC_SILENT, raw: 'x' })).toBe(`${PC_SILENT}（原文：x）`);
    expect(withRaw({ text: PC_SILENT, raw: '' })).toBe(PC_SILENT);
  });

  it("the PC's English failure texts become Chinese, the original kept", () => {
    expect(explainPcError('the response was cut off')).toEqual({ text: '电脑那边的响应中断了。', raw: 'the response was cut off' });
    expect(explainPcError('no data from the listener for 60000 ms').text).toMatch(/太久/);
    expect(explainPcError('the link to the PC has ended: closed').text).toMatch(/连接断了/);
    expect(explainPcError('something new').raw).toBe('something new');
    expect(explainPcError('something new').text).toMatch(/[一-鿿]/);
  });

  it('a link that ended on a protocol error says the two versions differ', () => {
    expect(explainLinkEnd('protocol: unknown kind 9')?.text).toMatch(/版本不一致/);
    expect(explainLinkEnd('closed')).toBeNull();
  });
});

/** Spec §10: the default shell screens never say MQTT / WebRTC / STUN / ICE (the raw 原文 is the browser's or the PC's). */
describe('shell wording', () => {
  const DIR = __dirname;
  const texts = (src: string, file: string): string[] => {
    const out: string[] = [];
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      const n = x as { type: string; [k: string]: any };
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'TSLiteralType') return;
      if (n.type === 'ExportNamedDeclaration' && n.source) return;
      if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value);
      if (n.type === 'TemplateElement') out.push(n.value?.cooked ?? '');
      for (const k of Object.keys(n)) if (k !== 'type') walk(n[k]);
    };
    walk(parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }));
    return out;
  };

  it('no implementation word in any string of the shell', () => {
    const files = fs.readdirSync(DIR).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
    expect(files).toContain('ui.ts');
    const bad: string[] = [];
    for (const f of files) {
      for (const t of texts(fs.readFileSync(path.join(DIR, f), 'utf8'), f)) if (/\b(MQTT|WebRTC|STUN|ICE)\b/i.test(t)) bad.push(`${f}: ${t}`);
    }
    expect(bad).toEqual([]);
  });
});
