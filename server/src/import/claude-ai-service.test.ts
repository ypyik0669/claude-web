import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './zip.js';
import { ClaudeAiImport, MAX_INSTRUCTIONS } from './claude-ai-service.js';
import { ClaudeAiSource } from '../library/claudeai-source.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'claude-ai-export');
let root: string, folder: string;

function setup() {
  const workspaces: any[] = [];
  const joined: string[] = [];
  const source = new ClaudeAiSource(path.join(root, 'claude-ai'));
  const svc = new ClaudeAiImport({
    root: path.join(root, 'claude-ai'),
    meta: {
      workspaces: () => workspaces,
      addWorkspace: async (p) => { const w = { id: `w${workspaces.length + 1}`, path: p, name: path.basename(p) }; workspaces.push(w); return w; },
      updateWorkspace: async (id, patch) => { Object.assign(workspaces.find((w) => w.id === id), patch); },
    },
    library: { join: async (k) => { joined.push(k); }, invalidate: () => {} },
    source,
  });
  const upload = (over: Record<string, string> = {}) => {
    fs.mkdirSync(svc.uploadsDir(), { recursive: true });
    const p = path.join(svc.uploadsDir(), `u${Math.random().toString(16).slice(2)}.zip`);
    fs.writeFileSync(p, makeZip(Object.fromEntries(['conversations.json', 'projects.json', 'users.json'].map((n) => [n, over[n] ?? fs.readFileSync(path.join(FIX, n))])), { deflate: true }));
    return p;
  };
  return { svc, source, workspaces, joined, upload };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cai-'));
  folder = path.join(root, 'mine'); fs.mkdirSync(folder);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ClaudeAiImport', () => {
  it('scans: what is in it and what would be new', async () => {
    const t = setup();
    expect(await t.svc.scan(t.upload())).toEqual({ conversations: 3, projects: 1, docs: 1, add: 3, update: 0, same: 0, skipped: 2, user: 'Ada Example' });
  });

  it('imports conversations into the library source and projects into a folder you pick; re-import dedupes and keeps files', async () => {
    const t = setup();
    const z = t.upload();
    const r = await t.svc.run(z, folder);
    expect(r).toMatchObject({ add: 3, projectsCreated: 1, filesWritten: 1, filesKept: 0 });
    expect(fs.existsSync(z)).toBe(false); // the upload is removed
    expect(t.joined).toEqual(['claudeai']);
    expect(t.workspaces[0]).toMatchObject({ path: path.join(folder, 'Garden'), instructions: 'Answer like a gardener.', claudeAiUuid: 'p-1111-garden' });
    expect(fs.readFileSync(path.join(folder, 'Garden', 'soil.md'), 'utf8')).toBe('# Soil\nLoam.');
    const list = (await t.source.list({ limit: 50 })).items;
    expect(list.map((s) => s.sessionId)).toEqual(['claudeai-5f1c2a9e-3333-4a2b-9c3d-000000000003', 'claudeai-5f1c2a9e-2222-4a2b-9c3d-000000000002', 'claudeai-5f1c2a9e-1111-4a2b-9c3d-000000000001']);
    expect(list[2]).toMatchObject({ title: 'Plan a garden', agent: 'claudeai', caps: { continueInClaude: true } });
    const page = await t.source.read('5f1c2a9e-1111-4a2b-9c3d-000000000001', { limit: 2 });
    expect(page.messages).toHaveLength(2);
    expect(page.next).toBeDefined();
    const older = await t.source.read('5f1c2a9e-1111-4a2b-9c3d-000000000001', { limit: 2, cursor: page.next });
    expect(JSON.stringify(older.messages)).toContain('Help me plan my beds');
    // again: nothing new, the project is updated, the user's edited file is not overwritten
    fs.writeFileSync(path.join(folder, 'Garden', 'soil.md'), 'my edits');
    const again = await t.svc.run(t.upload(), folder);
    expect(again).toMatchObject({ add: 0, same: 3, projectsCreated: 0, projectsUpdated: 1, filesWritten: 0, filesKept: 1 });
    expect(fs.readFileSync(path.join(folder, 'Garden', 'soil.md'), 'utf8')).toBe('my edits');
    expect(t.workspaces).toHaveLength(1);
  });

  it('instructions longer than workspaces.update allows are cut to the limit and the summary says so', async () => {
    const t = setup();
    const projects = JSON.parse(fs.readFileSync(path.join(FIX, 'projects.json'), 'utf8'));
    const long = 'x'.repeat(MAX_INSTRUCTIONS + 500);
    for (const p of projects) if (p.uuid === 'p-1111-garden') p.prompt_template = long;
    const r = await t.svc.run(t.upload({ 'projects.json': JSON.stringify(projects) }), folder);
    expect(r.instructionsShortened).toBe(1);
    expect(t.workspaces[0].instructions).toBe(long.slice(0, MAX_INSTRUCTIONS));
    expect(MAX_INSTRUCTIONS).toBe(20_000);
    const normal = setup();
    expect((await normal.svc.run(normal.upload(), folder)).instructionsShortened).toBeUndefined();
  });

  it('no folder: conversations only', async () => {
    const t = setup();
    const r = await t.svc.run(t.upload());
    expect(r).toMatchObject({ add: 3, projectsCreated: 0 });
    expect(t.workspaces).toEqual([]);
  });

  it('a relative folder is refused before anything is imported (it put the projects under the server’s working directory)', async () => {
    const t = setup();
    for (const f of ['.', 'mine']) await expect(t.svc.run(t.upload(), f), f).rejects.toThrow(/完整路径/);
    expect(t.workspaces).toEqual([]);
    expect(t.joined).toEqual([]);
    expect(fs.existsSync(path.join(root, 'claude-ai', 'conversations'))).toBe(false);
    // blank is no folder, as before
    expect(await t.svc.run(t.upload(), '  ')).toMatchObject({ projectsCreated: 0 });
  });

  it('a conversation whose id cannot be a file name is skipped and counted as skipped, not as added', async () => {
    const t = setup();
    fs.mkdirSync(t.svc.uploadsDir(), { recursive: true });
    const convs = JSON.parse(fs.readFileSync(path.join(FIX, 'conversations.json'), 'utf8'));
    convs.push({ ...convs[0], uuid: '../../pwn' });
    const p = path.join(t.svc.uploadsDir(), 'evil.zip');
    fs.writeFileSync(p, makeZip({ 'conversations.json': JSON.stringify(convs) }, { deflate: true }));
    expect(await t.svc.scan(p)).toMatchObject({ conversations: 3, add: 3, skipped: 3 });
    const r = await t.svc.run(p);
    expect(r).toMatchObject({ add: 3, skipped: 3 });
    expect(fs.readdirSync(path.join(root, 'claude-ai', 'conversations'))).toHaveLength(3);
    expect(fs.existsSync(path.join(root, 'pwn.json'))).toBe(false);
  });

  it('a zip bomb is refused with a clear message', async () => {
    const t = setup();
    (t.svc as any).o.zipLimits = { maxEntry: 1024 * 1024, maxTotal: 1024 * 1024 }; // the real caps are 512 MB
    fs.mkdirSync(t.svc.uploadsDir(), { recursive: true });
    const p = path.join(t.svc.uploadsDir(), 'bomb.zip');
    // a bomb next to the export is never opened (only the three JSON files are)
    fs.writeFileSync(p, makeZip({ 'conversations.json': '[]', 'bomb.bin': Buffer.alloc(4 * 1024 * 1024) }, { deflate: true }));
    expect(await t.svc.scan(p)).toMatchObject({ conversations: 0 });
    fs.writeFileSync(p, makeZip({ 'conversations.json': Buffer.alloc(4 * 1024 * 1024, 0x20) }, { deflate: true }));
    await expect(t.svc.scan(p)).rejects.toThrow(/太大/);
    // a broken directory: not a zip
    const z = makeZip({ 'conversations.json': '[]' });
    z.writeUInt32LE(0xffff, z.length - 22 - 46 - 18 + 20); // csize past the end of the data
    fs.writeFileSync(p, z);
    await expect(t.svc.scan(p)).rejects.toThrow(/zip/);
  });

  it('re-import: documents go only under the folder picked this time; instructions only when the project has none', async () => {
    const t = setup();
    await t.svc.run(t.upload(), folder);
    // the user moved the project elsewhere and wrote their own instructions
    const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere);
    t.workspaces[0].path = elsewhere;
    t.workspaces[0].instructions = 'my own rules';
    const other = path.join(root, 'other'); fs.mkdirSync(other);
    const again = await t.svc.run(t.upload(), other);
    expect(fs.readdirSync(elsewhere)).toEqual([]); // nothing written outside the picked folder
    expect(again).toMatchObject({ projectsUpdated: 1, filesWritten: 0 });
    expect(t.workspaces[0].instructions).toBe('my own rules');
  });

  it('uploads nobody imported are swept after a day', () => {
    const t = setup();
    const old = t.upload(), fresh = t.upload();
    const day = 24 * 3_600_000;
    fs.utimesSync(old, new Date(Date.now() - day - 60_000), new Date(Date.now() - day - 60_000));
    expect(t.svc.sweepUploads()).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('only a file the upload endpoint wrote', async () => {
    const t = setup();
    const outside = path.join(root, 'x.zip');
    fs.writeFileSync(outside, 'x');
    await expect(t.svc.scan(outside)).rejects.toThrow();
    await expect(t.svc.scan(path.join(t.svc.uploadsDir(), '..', 'x.zip'))).rejects.toThrow();
  });
});
