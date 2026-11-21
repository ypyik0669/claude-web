import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { decode, fetchPinned, findIn, LABELS, PrivacyModel, type Logits, type PinnedFile } from './index.js';
import { Tokenizer } from './tokenizer.js';

const tmp: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pii-')); tmp.push(d); return d; };
const serve = async (files: Record<string, Buffer>) => {
  const s = http.createServer((req, res) => {
    const f = files[decodeURIComponent(new URL(req.url!, 'http://x').pathname)];
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': f.length }).end(f);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

// a charsmap that maps nothing (a one-unit trie), and a handful of pieces
const NO_MAP = Buffer.from([4, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
const tinyTokenizer = () => ({
  normalizer: { type: 'Precompiled', precompiled_charsmap: NO_MAP },
  added_tokens: [{ id: 0, content: '<s>', special: true }, { id: 2, content: '</s>', special: true }],
  model: { type: 'Unigram', unk_id: 3, vocab: [['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0], ['▁', -2], ['▁ask', -1], ['▁Rina', -1], ['▁Kowalczyk', -1], ['▁about', -1], ['▁it', -1], ['K', -5], ['o', -5]] },
});
const PERSON_B = LABELS.indexOf('B-private_person');
const PERSON_I = LABELS.indexOf('I-private_person');

/** logits that call ids 6 / 7 (Rina, Kowalczyk) a person, everything else O */
const fakeLogits: Logits = async (ids) => {
  const k = LABELS.length;
  const out = new Float32Array(ids.length * k);
  ids.forEach((id, i) => { const c = id === 6 ? PERSON_B : id === 7 ? PERSON_I : 0; out[i * k + c] = 10; });
  return out;
};

describe('the local PII model', () => {
  it('the tokenizer splits into pieces with their offsets, unknown runs as one <unk>', () => {
    const t = new Tokenizer(tinyTokenizer());
    expect(t.encode('ask Rina Kowalczyk').map((x) => [x.id, x.start, x.end])).toEqual([[5, 0, 3], [6, 4, 8], [7, 9, 18]]);
    const u = t.encode('ask zz');
    expect(u.map((x) => x.id)).toEqual([5, 4, 3]);
    expect(t.encode('<s>ask</s>').map((x) => x.id)).toEqual([0, 5, 2]);
  });

  it('decode reads BIO tags into spans, the least score, and drops what is under the floor', () => {
    const toks = [{ id: 1, start: 0, end: 3 }, { id: 2, start: 4, end: 8 }, { id: 3, start: 8, end: 12 }, { id: 4, start: 13, end: 15 }];
    const spans = decode(toks, [0, PERSON_B, PERSON_I, LABELS.indexOf('B-email')], [1, 0.9, 0.7, 0.3]);
    expect(spans).toEqual([{ start: 4, end: 12, kind: 'private_person', score: 0.7 }]);
  });

  it('findIn runs windows over a long text and labels every token once', async () => {
    const t = new Tokenizer(tinyTokenizer());
    const text = `${'ask '.repeat(700)}Rina Kowalczyk about it`;
    let calls = 0;
    const spans = await findIn(t, async (ids) => { calls++; expect(ids.length).toBeLessThanOrEqual(512); return fakeLogits(ids); }, text);
    expect(calls).toBeGreaterThan(1);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end).trim()).toBe('Rina Kowalczyk');
  });

  it('a pinned download is checked: a wrong SHA-256 leaves nothing behind', async () => {
    const good = Buffer.from('model bytes');
    const base = await serve({ '/a': good });
    const dir = mkdir();
    const f: PinnedFile = { path: 'a', size: good.length, sha256: sha(good) };
    await fetchPinned(`${base}/a`, path.join(dir, 'a'), f);
    expect(fs.readFileSync(path.join(dir, 'a'), 'utf8')).toBe('model bytes');
    await expect(fetchPinned(`${base}/a`, path.join(dir, 'b'), { ...f, sha256: '0'.repeat(64) })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['a']);
    await expect(fetchPinned(`${base}/a`, path.join(dir, 'c'), { ...f, size: 3 })).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'c.part'))).toBe(false);
  });

  it('not installed / no runtime is a clear state; download, find, remove', async () => {
    const tj = Buffer.from(JSON.stringify(tinyTokenizer()));
    const onnx = Buffer.from('onnx');
    const files: PinnedFile[] = [{ path: 'int8/tokenizer.json', size: tj.length, sha256: sha(tj) }, { path: 'int8/model_int8.onnx', size: onnx.length, sha256: sha(onnx) }];
    const base = await serve({ '/rev1/int8/tokenizer.json': tj, '/rev1/int8/model_int8.onnx': onnx });
    const root = mkdir();
    expect(new PrivacyModel(null).status()).toMatchObject({ installed: false });
    expect(new PrivacyModel(null).missing()).toBe('files');
    const bare = new PrivacyModel(root, { files, base: `${base}/`, rev: 'rev1', runtimeAvailable: () => false });
    expect(bare.status()).toMatchObject({ installed: false, runtime: false });
    expect(bare.missing()).toBe('files');
    await expect(bare.find(['x'], 0.8)).rejects.toThrow();

    const m = new PrivacyModel(root, { files, base: `${base}/`, rev: 'rev1', logits: async () => fakeLogits });
    let pushes = 0;
    m.listen(() => pushes++);
    await m.download();
    expect(pushes).toBeGreaterThan(0);
    expect(m.status()).toMatchObject({ installed: true, runtime: true });
    expect(m.status().error).toBeUndefined();
    expect(m.missing()).toBeNull();
    // the files there but no runtime to run them with
    expect(new PrivacyModel(root, { files, rev: 'rev1', runtimeAvailable: () => false }).missing()).toBe('runtime');
    // a failure while running shows on the card (a request that went on with the rules alone leaves no other trace)
    const broken = new PrivacyModel(root, { files, rev: 'rev1', logits: async () => async () => { throw new Error('session crashed'); } });
    await expect(broken.find(['ask Rina'], 0.8)).rejects.toThrow('session crashed');
    expect(broken.status().error).toBe('session crashed');
    const [got] = await m.find(['ask Rina Kowalczyk about it'], 0.8);
    expect(got).toEqual([{ start: 4, end: 18, category: 'name' }]);
    // a file changed on disk after the check is no longer installed (one already in memory still runs)
    fs.appendFileSync(path.join(m.dir()!, 'tokenizer.json'), ' ');
    expect(m.installed()).toBe(false);
    expect(m.missing()).toBeNull();
    await m.remove();
    expect(fs.existsSync(m.dir()!)).toBe(false);
    expect(m.missing()).toBe('files');
  });

  it('a download that fails says why and installs nothing', async () => {
    const base = await serve({});
    // the runtime counts as present: without that the download would fetch the real onnxruntime from npm first
    const m = new PrivacyModel(mkdir(), { files: [{ path: 'x', size: 1, sha256: '0'.repeat(64) }], base: `${base}/`, rev: 'r', runtimeAvailable: () => true });
    await m.download();
    expect(m.status().installed).toBe(false);
    expect(m.status().error).toMatch(/404/);
  });

  // The real tokenizer against Hugging Face's output (Magpie's testdata/tokens.json, offsets in characters):
  // CW_PII_DIR=<dir with tokenizer.json (pinned) and golden.json>
  const dir = process.env.CW_PII_DIR;
  it.skipIf(!dir || !fs.existsSync(path.join(dir, 'golden.json')))('matches the tokenizers library on its golden cases', () => {
    const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(dir!, 'tokenizer.json'), 'utf8')));
    const golden = JSON.parse(fs.readFileSync(path.join(dir!, 'golden.json'), 'utf8')) as { text: string; tokens: [number, number, number][] }[];
    for (const g of golden) {
      const cp = new Map<number, number>();
      let ci = 0, ui = 0;
      for (const ch of g.text) { cp.set(ci++, ui); ui += ch.length; }
      cp.set(ci, ui);
      expect(tok.encode(g.text).map((t) => [t.id, t.start, t.end])).toEqual(g.tokens.map(([id, s, e]) => [id, cp.get(s), cp.get(e)]));
    }
  });

  // End to end with the real model: CW_PII_DIR/data holds the downloaded files, CW_PII_ORT a dir with onnxruntime-node
  const ort = process.env.CW_PII_ORT;
  it.skipIf(!dir || !ort)('the real model finds a name, an email and an address', async () => {
    const req = createRequire(path.join(ort!, 'package.json'));
    const m = new PrivacyModel(path.join(dir!, 'data'), { runtime: () => import(pathToFileURL(req.resolve('onnxruntime-node')).href), runtimeAvailable: () => true });
    await m.download();
    const t = '请把合同发给王芳，她的邮箱是 wangfang@example.com，住在北京市朝阳区建国路88号。';
    const [got] = await m.find([t], 0.8);
    const said = got.map((s) => `${s.category}:${t.slice(s.start, s.end)}`);
    expect(said).toEqual(expect.arrayContaining(['name:王芳', 'email:wangfang@example.com']));
    expect(said.some((x) => x.startsWith('address:'))).toBe(true);
  }, 120_000);
});
