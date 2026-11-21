// 导入 claude.ai 数据 (stage F4): a one-time import of the export zip (not a live sync; claude.ai is never contacted).
// Conversations → `<data>/claude-ai/conversations/<uuid>.json` (the claude.ai library source reads them); projects →
// projects here (one sub-folder per project in the folder the user picked, the project's documents written there, its
// custom instructions as the project's instructions). Read-only toward the user's files except that folder, where an
// existing file is never overwritten. Re-importing dedupes by uuid (a newer conversation replaces the old copy).
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, ClaudeAiImportResult, ClaudeAiScan } from '../protocol.js';
import { readZipFile, ZipTooLarge } from './zip.js';
import { parseExport, planImport, safeName, SAFE_ID, type ClaudeAiExport } from './claude-ai.js';
import { conversationsDir, type StoredConversation } from '../library/claudeai-source.js';
import { projectPath } from '../meta/workspace-folders.js';
import { tr } from '../i18n/index.js';

export const CLAUDEAI_UPLOAD_MAX = 1024 * 1024 * 1024;
/** the limit workspaces.update enforces on project instructions (server/src/ws/hub.ts) */
export const MAX_INSTRUCTIONS = 20_000;
const EXPORT_FILES = new Set(['conversations.json', 'projects.json', 'users.json']);
const isInside = (base: string, p: string) => {
  const r = path.relative(path.resolve(base), path.resolve(p));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

export interface ClaudeAiImportOpts {
  root: string;
  meta: {
    workspaces(): { id: string; path: string; name: string; claudeAiUuid?: string; instructions?: string }[];
    addWorkspace(p: string): Promise<{ id: string; path: string }>;
    updateWorkspace(id: string, patch: { instructions?: string | null; claudeAiUuid?: string }): Promise<unknown>;
  };
  library: { join(kind: AgentKind, on: boolean): Promise<void>; invalidate(kind?: AgentKind): void };
  source?: { invalidate(): void };
  now?(): number;
  /** Tests only: smaller caps than the reader's 512 MB. */
  zipLimits?: { maxEntry?: number; maxTotal?: number };
}

export class ClaudeAiImport {
  constructor(private readonly o: ClaudeAiImportOpts) {}

  uploadsDir() { return path.join(this.o.root, 'uploads'); }

  /** An upload nobody imported (the dialog was closed): removed after a day. */
  sweepUploads(maxAgeMs = 24 * 3_600_000): number {
    const dir = this.uploadsDir();
    const now = (this.o.now ?? Date.now)();
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      const f = path.join(dir, name);
      try { if (now - fs.statSync(f).mtimeMs > maxAgeMs) { fs.rmSync(f, { force: true }); n++; } } catch { /* in use / gone */ }
    }
    return n;
  }

  /** Only a file our own upload endpoint wrote. */
  private zipPath(p: string): string {
    const abs = path.resolve(String(p ?? ''));
    const dir = path.resolve(this.uploadsDir());
    if (!abs.startsWith(dir + path.sep) || !abs.endsWith('.zip') || !fs.existsSync(abs)) throw new Error(tr('找不到上传的导出包，请重新选择'));
    return abs;
  }

  private parse(p: string): ClaudeAiExport {
    let files: Map<string, Buffer>;
    // only the three JSON files are inflated, each and all together capped (a zip bomb stops at the cap); the zip is
    // read by offsets, never whole
    try { files = readZipFile(this.zipPath(p), { ...this.o.zipLimits, want: (n) => EXPORT_FILES.has(n.split('/').pop()!) }); } catch (e) {
      if (e instanceof ZipTooLarge) throw new Error(tr('导出包里的文件太大，读不了（单个文件和合计都不能超过 512 MB）'));
      throw new Error(tr('这不是一个 zip 文件'));
    }
    return parseExport(files);
  }

  private existing(): Map<string, string> {
    const out = new Map<string, string>();
    const dir = conversationsDir(this.o.root);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const n of names) {
      try { const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as StoredConversation; if (s?.conv?.uuid) out.set(s.conv.uuid, s.conv.updatedAt); } catch { /* skipped */ }
    }
    return out;
  }

  private summary(x: ClaudeAiExport): ClaudeAiScan {
    const plan = planImport(x.conversations, this.existing());
    return {
      conversations: x.conversations.length, projects: x.projects.length, docs: x.projects.reduce((n, p) => n + p.docs.length, 0),
      add: plan.add.length, update: plan.update.length, same: plan.same.length, skipped: x.skipped,
      ...(x.user ? { user: x.user.name || x.user.email } : {}),
    };
  }

  async scan(p: string): Promise<ClaudeAiScan> { return this.summary(this.parse(p)); }

  async run(p: string, folder?: string): Promise<ClaudeAiImportResult> {
    const x = this.parse(p);
    const scan = this.summary(x);
    const plan = planImport(x.conversations, this.existing());
    let projectsCreated = 0, projectsUpdated = 0, filesWritten = 0, filesKept = 0, instructionsShortened = 0;
    const projectDir = new Map<string, string>();
    // a full path only: a relative one would put the projects under the server's own working directory (projectPath)
    const base = typeof folder === 'string' && folder.trim() ? path.resolve(projectPath(folder.trim())) : '';
    if (base) {
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error(tr('找不到这个文件夹：{f}', { f: base }));
      for (const pr of x.projects) {
        let w = this.o.meta.workspaces().find((ws) => ws.claudeAiUuid === pr.uuid);
        if (w) projectsUpdated++;
        else {
          const dir = path.join(base, safeName(pr.name, pr.uuid.slice(0, 8)));
          fs.mkdirSync(dir, { recursive: true });
          const added = await this.o.meta.addWorkspace(dir);
          w = this.o.meta.workspaces().find((ws) => ws.id === added.id) ?? { ...added, name: pr.name };
          projectsCreated++;
        }
        // the instructions only when the project has none (a re-import never replaces what the user wrote)
        const setInstr = pr.instructions.trim() && !w.instructions?.trim();
        // cut to the limit workspaces.update enforces, so saving the project later doesn't fail
        let instructions = pr.instructions;
        if (setInstr && instructions.length > MAX_INSTRUCTIONS) { instructions = instructions.slice(0, MAX_INSTRUCTIONS); instructionsShortened++; }
        await this.o.meta.updateWorkspace(w.id, { claudeAiUuid: pr.uuid, ...(setInstr ? { instructions } : {}) });
        projectDir.set(pr.uuid, w.path);
        // files are written only under the folder picked this time (a project moved elsewhere keeps its folder untouched)
        if (!isInside(base, w.path)) continue;
        if (!fs.existsSync(w.path)) fs.mkdirSync(w.path, { recursive: true });
        for (const d of pr.docs) {
          const file = path.join(w.path, safeName(d.filename, 'document.txt'));
          if (fs.existsSync(file)) { filesKept++; continue; }
          fs.writeFileSync(file, d.content, { flag: 'wx' });
          filesWritten++;
        }
      }
    }
    const dir = conversationsDir(this.o.root);
    fs.mkdirSync(dir, { recursive: true });
    const adds = new Set(plan.add), updates = new Set(plan.update);
    const now = (this.o.now ?? Date.now)();
    // counted as written only when the file really is (parseExport already skips ids that can't be file names)
    let added = 0, updated = 0, refused = 0;
    for (const c of x.conversations) {
      if (!adds.has(c.uuid) && !updates.has(c.uuid)) continue;
      if (!SAFE_ID.test(c.uuid)) { refused++; continue; }
      const cwd = (c.projectUuid && projectDir.get(c.projectUuid)) || undefined;
      const stored: StoredConversation = { conv: c, ...(cwd ? { cwd } : {}), importedAt: now };
      const file = path.join(dir, `${c.uuid}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(stored));
      fs.renameSync(`${file}.tmp`, file);
      if (adds.has(c.uuid)) added++; else updated++;
    }
    if (x.conversations.length) await this.o.library.join('claudeai', true);
    this.o.source?.invalidate();
    this.o.library.invalidate('claudeai');
    fs.rmSync(this.zipPath(p), { force: true });
    return { ...scan, add: added, update: updated, skipped: scan.skipped + refused, projectsCreated, projectsUpdated, filesWritten, filesKept, ...(instructionsShortened ? { instructionsShortened } : {}) };
  }
}
