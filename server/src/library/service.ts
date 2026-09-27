// Unified session library (Task 8): one list / read / search surface over every joined source.
// Claude is always joined; every other source is opt-in (constraints.md) — a source that hasn't been
// joined is never listed, read, indexed or even status()-probed, only lightly detected through the
// AgentRegistry version probe and whether its data directory exists.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import type { AgentKind, SessionSummary, SourceStatus } from '../protocol.js';
import type { AgentTranscripts, Head } from '../agents/transcript.js';
import type { MetaStore } from '../meta/store.js';
import { dataDir } from '../files/service.js';
import { LibraryIndex } from './index-db.js';
import { libraryId, parseLibraryId } from './ids.js';
import type { SessionSource } from './types.js';

const LIST_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000; // per source, per list() — see bounded()
const PAGE = 100; // Codex thread/list page size (and everyone else's)
const MAX_PAGES = 500;
const READ_PAGE = 50;
const TRASH_KEEP_MS = 30 * 86_400_000;
const UNSUPPORTED = '该来源不支持此操作';

/** The slice of AgentRegistry the library needs (cheap defs + the 60 s-cached version probe). */
export interface LibraryAgents {
  defs(): { kind: AgentKind; name: string; protocol: string }[];
  list(refresh?: boolean): Promise<{ kind: AgentKind; name: string; installed: boolean }[]>;
}

export interface LibraryOptions {
  agents?: LibraryAgents;
  /** Builds a source on join for kinds not passed to the constructor (ACP agents). */
  makeSource?: (kind: AgentKind) => SessionSource | null;
  /** Fallback search while the index is still empty (SessionsService.search). */
  fallbackSearch?: (q: string, limit: number) => Promise<{ session: SessionSummary; snippet?: string }[]>;
  /** Data dirs whose existence counts as "detected". Defaults: codex ~/.codex/sessions, opencode ~/.local/share/opencode. */
  dataDirs?: Partial<Record<AgentKind, string[]>>;
  trashDir?: string;
  /** Per-source list timeout (default 20 s); tests shorten it. */
  listTimeoutMs?: number;
  /** How long a source's list stays fresh (default 60 s); past it the cache is served and refreshed behind. */
  listTtlMs?: number;
}

interface Resolved { kind: AgentKind; nativeId?: string; source?: SessionSource; head: Head | null }

function defaultDataDirs(): Partial<Record<AgentKind, string[]>> {
  const home = os.homedir();
  const oc = [path.join(home, '.local', 'share', 'opencode')];
  if (process.env.LOCALAPPDATA) oc.push(path.join(process.env.LOCALAPPDATA, 'opencode'));
  return { codex: [path.join(home, '.codex', 'sessions')], opencode: oc };
}

function defaultWatchDirs(): Partial<Record<AgentKind, string[]>> {
  const claude = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return { claude: [path.join(claude, 'projects')], codex: [path.join(os.homedir(), '.codex', 'sessions')] };
}

/** user + assistant text blocks only — what the index stores for full-text search. */
export function messagesText(msgs: any[]): string {
  const out: string[] = [];
  for (const m of msgs) {
    if (m?.type !== 'user' && m?.type !== 'assistant') continue;
    const c = m.message?.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out.join('\n');
}

export class LibraryService extends EventEmitter {
  private srcs = new Map<AgentKind, SessionSource>();
  /** Last good list per source. `dirty`: invalidated (a mutation / watcher) — the next list() waits (bounded) for a refetch. */
  private perKind = new Map<AgentKind, { at: number; items: SessionSummary[]; dirty?: boolean }>();
  private errors = new Map<AgentKind, string>();
  /** Kinds whose current `errors` entry is a list timeout (cleared by the next successful fetch). */
  private timeoutErr = new Set<AgentKind>();
  /** First load still running past the list bound: no cache yet, not an error. */
  private loading = new Set<AgentKind>();
  /** In-flight fetches that outlived a caller's bound (they emit 'changed' when they settle). */
  private late = new Set<Promise<SessionSummary[]>>();
  private indexedAtByKind = new Map<AgentKind, number>();
  private fetching = new Map<AgentKind, { gen: number; p: Promise<SessionSummary[]> }>();
  /** Bumped by invalidate(): a fetch started under an older generation is neither joined nor cached as fresh. */
  private gens = new Map<AgentKind, number>();
  private allGen = 0;
  /** Bumped when a source is left: a fetch started before that must not touch any state afterwards. */
  private leaves = new Map<AgentKind, number>();
  /** transcripts.entries() failed on the last list(): claude-web's own sessions are unknown, don't prune them. */
  private localFailed = false;
  /** Until the first refreshIndex pass completes, search uses the old transcript scan (a half-built index misses things). */
  private indexReady = false;
  private byId = new Map<string, SessionSummary>();
  private resuming = new Map<string, Promise<{ agent: AgentKind; cwd: string }>>();
  private indexing: Promise<void> | null = null;
  private indexAgain = false;
  private timers: NodeJS.Timeout[] = [];
  /** chokidar watchers, one per joined source that has watch dirs (claude always; others while joined). */
  private watchers = new Map<AgentKind, ReturnType<typeof chokidar.watch>>();
  private watchDirs: Partial<Record<AgentKind, string[]>> | null = null;
  private indexTimer: NodeJS.Timeout | null = null;
  /** Kinds passed to the constructor (Codex / OpenCode); ACP sources are built on join and dropped on leave. */
  private builtin = new Set<AgentKind>();
  private readonly trashDir: string;
  private readonly dataDirs: Partial<Record<AgentKind, string[]>>;

  constructor(sources: SessionSource[], private index: LibraryIndex, private transcripts: AgentTranscripts, private meta: MetaStore, private opts: LibraryOptions = {}) {
    super();
    for (const s of sources) { this.srcs.set(s.kind, s); this.builtin.add(s.kind); }
    this.trashDir = opts.trashDir ?? path.join(dataDir(), 'library-trash');
    this.dataDirs = opts.dataDirs ?? defaultDataDirs();
  }

  // ---------- settings ----------
  private setting(k: 'library.joined' | 'library.dismissed'): AgentKind[] {
    const v = this.meta.settings()[k];
    return Array.isArray(v) ? (v as AgentKind[]) : [];
  }
  isJoined(kind: AgentKind) { return kind === 'claude' || this.setting('library.joined').includes(kind); }

  /** The source for a kind, built on demand (ACP) — only ever called for joined kinds. */
  private source(kind: AgentKind): SessionSource | undefined {
    let s = this.srcs.get(kind);
    if (!s && this.opts.makeSource) {
      s = this.opts.makeSource(kind) ?? undefined;
      if (s) this.srcs.set(kind, s);
    }
    return s;
  }

  private joinedSources(): SessionSource[] {
    const kinds = new Set<AgentKind>(['claude', ...this.setting('library.joined')]);
    return [...kinds].map((k) => this.source(k)).filter((s): s is SessionSource => !!s);
  }

  /** Every kind the library knows how to list (constructed sources + ACP agents from the registry). */
  private candidateKinds(): AgentKind[] {
    const kinds = new Set<AgentKind>(this.srcs.keys());
    if (this.opts.makeSource) for (const d of this.opts.agents?.defs() ?? []) if (d.protocol === 'acp' && d.kind !== 'claude') kinds.add(d.kind);
    kinds.delete('claude');
    return ['claude', ...kinds];
  }

  // ---------- list ----------
  /**
   * Mark a source's list stale. Hard (default — after our own mutation): the next list() waits
   * (bounded) for a refetch, and a fetch already in flight is superseded. Soft (a file watcher saw
   * the source's data change): just expire the TTL, so the next list() serves the cache and
   * revalidates behind it.
   */
  invalidate(kind?: AgentKind, o: { soft?: boolean } = {}) {
    // stale, not forgotten: a source that fails on the next fetch still serves its last good list
    for (const [k, v] of this.perKind) if (!kind || k === kind) { v.at = 0; if (!o.soft) v.dirty = true; }
    if (o.soft) return;
    if (kind) this.gens.set(kind, (this.gens.get(kind) ?? 0) + 1);
    else this.allGen++;
  }

  private async listPages(src: SessionSource, archived: boolean): Promise<SessionSummary[]> {
    const items: SessionSummary[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await src.list({ cursor, limit: PAGE, archived });
      items.push(...(archived ? r.items.map((x) => ({ ...x, archived: true })) : r.items));
      if (!r.next || seen.has(r.next)) break;
      seen.add(r.next);
      cursor = r.next;
    }
    return items;
  }

  /**
   * One in-flight fetch per source: concurrent list() calls share it.
   *
   * Stale-while-revalidate: a cached list that merely aged past the TTL is returned at once and
   * refreshed in the background ('changed' when the refresh lands). Only a first load, or a list
   * explicitly invalidated (our own mutation, a watcher event), waits — and that wait is bounded.
   */
  private listSource(src: SessionSource): Promise<SessionSummary[]> {
    const hit = this.perKind.get(src.kind);
    if (hit && !hit.dirty && Date.now() - hit.at < (this.opts.listTtlMs ?? LIST_TTL_MS)) return Promise.resolve(hit.items);
    const gen = this.genOf(src.kind);
    const running = this.fetching.get(src.kind);
    const p = running && running.gen === gen ? running.p : this.startFetch(src, gen);
    if (hit && !hit.dirty) {
      this.late.add(p); // announce when it lands
      return Promise.resolve(hit.items);
    }
    // callers joining an in-flight fetch are bounded too — otherwise they'd wait out a hung source
    return this.bounded(src.kind, p);
  }

  private startFetch(src: SessionSource, gen: number): Promise<SessionSummary[]> {
    const errBefore = this.errors.get(src.kind);
    const p = this.fetchSource(src, gen).finally(() => { if (this.fetching.get(src.kind)?.p === p) this.fetching.delete(src.kind); });
    this.fetching.set(src.kind, { gen, p });
    // a fetch nobody waited for to the end (bound hit, or a background revalidation) announces itself
    // once when it settles — unless it only repeated the error already shown (no re-list loop)
    const settle = () => {
      if (!this.late.delete(p)) return;
      this.loading.delete(src.kind);
      const err = this.errors.get(src.kind);
      if (err && err === errBefore) return;
      this.emit('changed');
    };
    p.then(settle, settle);
    return p;
  }

  /**
   * One slow source must never stall the merged list: past `listTimeoutMs` the caller gets what's
   * cached and the fetch keeps running (still the shared in-flight one, so no duplicate starts); when
   * it lands it caches normally and 'changed' tells clients to re-list. With a last good list the
   * timeout is an error (stale data is being shown); with none yet — a first load — the source is
   * just `loading`, not failed.
   */
  private bounded(kind: AgentKind, p: Promise<SessionSummary[]>): Promise<SessionSummary[]> {
    const ms = this.opts.listTimeoutMs ?? LIST_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<SessionSummary[]>((res) => {
      timer = setTimeout(() => {
        this.late.add(p);
        const cached = this.perKind.get(kind);
        if (cached) {
          this.errors.set(kind, `列出会话超时（${Math.round(ms / 1000)} 秒），后台仍在读取`);
          this.timeoutErr.add(kind);
        } else {
          this.loading.add(kind);
        }
        res(cached?.items ?? []);
      }, ms);
      timer.unref?.();
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), late]);
  }

  private genOf(kind: AgentKind) { return this.allGen * 1_000_000 + (this.gens.get(kind) ?? 0); }

  private async fetchSource(src: SessionSource, gen: number): Promise<SessionSummary[]> {
    const hit = this.perKind.get(src.kind);
    const epoch = this.leaves.get(src.kind) ?? 0;
    const left = () => (this.leaves.get(src.kind) ?? 0) !== epoch;
    try {
      // sources that can archive also list their archived sessions (flagged), for the "show archived" view
      const [live, archived] = await Promise.all([this.listPages(src, false), src.caps.archive ? this.listPages(src, true) : Promise.resolve([])]);
      const liveIds = new Set(live.map((x) => x.sessionId));
      const items = [...live, ...archived.filter((x) => !liveIds.has(x.sessionId))];
      if (left()) return []; // the source was left meanwhile: no cache, no error, nothing
      // invalidated while in flight: keep it as a last-good fallback, but stale (the next list() refetches)
      const current = gen === this.genOf(src.kind);
      if (current || !this.perKind.has(src.kind)) this.perKind.set(src.kind, { at: current ? Date.now() : 0, items, dirty: !current });
      // a timeout error is cleared by any later successful fetch, whatever its generation
      if (current || this.timeoutErr.has(src.kind)) { this.errors.delete(src.kind); this.timeoutErr.delete(src.kind); }
      return items;
    } catch (e: any) {
      if (left()) return [];
      if (gen === this.genOf(src.kind)) { this.errors.set(src.kind, e?.message ?? String(e)); this.timeoutErr.delete(src.kind); }
      return hit?.items ?? [];
    }
  }

  async list(): Promise<SessionSummary[]> {
    const joined = this.joinedSources();
    const [lists, local] = await Promise.all([Promise.all(joined.map((s) => this.listSource(s))), this.transcripts.entries().then((r) => { this.localFailed = false; return r; }, () => { this.localFailed = true; return []; })]);
    const byId = new Map<string, SessionSummary>();
    joined.forEach((src, i) => {
      for (const it of lists[i]) {
        byId.set(it.sessionId, { ...it, agent: it.agent ?? src.kind, caps: it.caps ?? src.caps });
      }
    });
    const alias = new Map<string, string>(); // imported library id -> claude-web session id it was merged into
    const out = new Map(byId);
    for (const { summary, head } of local) {
      const lid = head.nativeSessionId ? libraryId(head.agent, head.nativeSessionId) : undefined;
      const src = lid ? byId.get(lid) : undefined;
      if (head.imported) {
        // a resume pointer: only shown through its source (and not at all once the source is left)
        if (src) out.set(lid!, { ...src, lastModified: Math.max(src.lastModified, summary.lastModified) });
        continue;
      }
      if (src && lid && this.isJoined(head.agent)) {
        out.delete(lid);
        alias.set(lid, summary.sessionId);
        out.set(summary.sessionId, { ...src, sessionId: summary.sessionId, agent: head.agent, lastModified: Math.max(src.lastModified, summary.lastModified), caps: src.caps });
      } else {
        out.set(summary.sessionId, summary);
      }
    }
    this.byId = new Map(out);
    // forks / resumed children / sub-agents fold under their top-level ancestor, transitively (a
    // sub-agent spawned by a sub-agent folds under the root, and childCount counts every descendant);
    // an orphan — its parent isn't listed — stays visible; a chain that runs into a parent cycle
    // isn't folded at all (every cycle member stays top-level rather than all of them vanishing)
    const all = new Map(out);
    const rootOf = (id: string): string => {
      let cur = id;
      const seen = new Set<string>([cur]);
      for (;;) {
        const p = all.get(cur)?.parentId;
        const pid = p ? alias.get(p) ?? p : undefined;
        if (!pid || !all.has(pid)) return cur;
        if (seen.has(pid)) return id;
        seen.add(pid);
        cur = pid;
      }
    };
    const kids = new Map<string, number>();
    for (const id of all.keys()) {
      const root = rootOf(id);
      if (root === id) continue;
      kids.set(root, (kids.get(root) ?? 0) + 1);
      out.delete(id);
    }
    for (const [root, n] of kids) {
      const r = out.get(root);
      if (r) out.set(root, { ...r, childCount: (r.childCount ?? 0) + n });
    }
    return [...out.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  // ---------- routing ----------
  /** Which agent a library id belongs to (a claude-web head wins, then the id prefix). */
  async kindOf(id: string): Promise<AgentKind> {
    const head = await this.transcripts.head(id);
    return head ? head.agent : parseLibraryId(id).kind;
  }

  private async resolve(id: string): Promise<Resolved> {
    const head = await this.transcripts.head(id);
    let kind: AgentKind;
    let nativeId: string | undefined;
    if (head) { kind = head.agent; nativeId = head.nativeSessionId; }
    else ({ kind, nativeId } = parseLibraryId(id));
    const source = this.isJoined(kind) ? this.source(kind) : undefined;
    return { kind, nativeId, source, head };
  }

  // ---------- read ----------
  async read(id: string, cursor?: string, limit = 20): Promise<{ messages: any[]; next?: string }> {
    const r = await this.resolve(id);
    if (r.head && !r.head.imported) return { messages: await this.transcripts.load(id) };
    if (!r.source || !r.nativeId) throw new Error('该会话的来源未加入会话库');
    return r.source.read(r.nativeId, { cursor, limit });
  }

  /** Every page, oldest first (each page is chronological; later pages are older). */
  async readAll(id: string): Promise<any[]> {
    const pages: any[][] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await this.read(id, cursor, READ_PAGE);
      pages.push(r.messages);
      if (!r.next || seen.has(r.next)) break;
      seen.add(r.next);
      cursor = r.next;
    }
    return pages.reverse().flat();
  }

  // ---------- sources / join ----------
  private async agentInfos() {
    try { return (await this.opts.agents?.list()) ?? []; } catch { return []; }
  }

  private dirExists(kind: AgentKind) {
    return (this.dataDirs[kind] ?? []).some((d) => existsSync(d));
  }

  async sources(): Promise<SourceStatus[]> {
    const infos = await this.agentInfos();
    const dismissed = this.setting('library.dismissed');
    return Promise.all(this.candidateKinds().map(async (kind): Promise<SourceStatus> => {
      const info = infos.find((x) => x.kind === kind);
      const defName = info?.name ?? this.opts.agents?.defs().find((d) => d.kind === kind)?.name ?? kind;
      const installed = !!info?.installed || this.dirExists(kind);
      if (!this.isJoined(kind)) {
        return { kind, name: defName, installed, detected: installed, joined: false, dismissed: dismissed.includes(kind), enabled: false };
      }
      const src = this.source(kind);
      let st: SourceStatus;
      try {
        st = src ? await src.status() : { kind, name: defName, installed, detected: installed, joined: true, dismissed: false, enabled: false, disabledReason: '没有可用的会话来源' };
      } catch (e: any) {
        st = { kind, name: defName, installed, detected: installed, joined: true, dismissed: false, enabled: false, error: e?.message ?? String(e) };
      }
      const err = this.errors.get(kind) ?? st.error;
      return {
        ...st,
        name: !st.name || st.name === kind ? defName : st.name,
        joined: true,
        dismissed: dismissed.includes(kind),
        count: this.perKind.get(kind)?.items.length,
        indexedAt: this.indexedAtByKind.get(kind),
        ...(this.loading.has(kind) ? { loading: true } : {}),
        ...(err ? { error: err } : {}),
      };
    }));
  }

  async detect(): Promise<AgentKind[]> {
    const infos = await this.agentInfos();
    const joined = this.setting('library.joined');
    const dismissed = this.setting('library.dismissed');
    return this.candidateKinds().filter((k) => k !== 'claude' && !joined.includes(k) && !dismissed.includes(k)
      && (!!infos.find((x) => x.kind === k)?.installed || this.dirExists(k)));
  }

  /** Emit 'discovered' with the detected-but-not-joined list (startup, and after agents.list refresh). */
  async announce(): Promise<AgentKind[]> {
    const kinds = await this.detect();
    this.emit('discovered', kinds);
    return kinds;
  }

  async join(kind: AgentKind, joined: boolean): Promise<void> {
    if (kind === 'claude') {
      if (!joined) throw new Error('Claude Code 会话始终在会话库里，不能移出');
      return;
    }
    const cur = this.setting('library.joined').filter((k) => k !== kind);
    if (joined) {
      if (!this.source(kind)) throw new Error(`没有 ${kind} 的会话来源`);
      await this.meta.setSetting('library.joined', [...cur, kind]);
      await this.meta.setSetting('library.dismissed', this.setting('library.dismissed').filter((k) => k !== kind));
      this.invalidate(kind);
      this.watch(kind);
      this.emit('changed');
      this.scheduleIndex();
      return;
    }
    await this.meta.setSetting('library.joined', cur);
    // in-flight fetches of this source are now stale: they must not re-cache or set errors
    this.leaves.set(kind, (this.leaves.get(kind) ?? 0) + 1);
    this.gens.set(kind, (this.gens.get(kind) ?? 0) + 1);
    this.fetching.delete(kind);
    this.unwatch(kind);
    const src = this.srcs.get(kind);
    await src?.close().catch(() => {});
    // an on-demand (ACP) source is rebuilt fresh on the next join
    if (src && !this.builtin.has(kind)) this.srcs.delete(kind);
    // only what this source listed — claude-web's own sessions with that agent stay (they're still listed)
    for (const s of this.perKind.get(kind)?.items ?? []) this.index.remove(s.sessionId);
    this.perKind.delete(kind);
    this.errors.delete(kind);
    this.timeoutErr.delete(kind);
    this.loading.delete(kind);
    this.indexedAtByKind.delete(kind);
    this.emit('changed');
  }

  async dismiss(kind: AgentKind): Promise<void> {
    const cur = this.setting('library.dismissed');
    if (!cur.includes(kind)) await this.meta.setSetting('library.dismissed', [...cur, kind]);
  }

  // ---------- mutations ----------
  private changed(kind?: AgentKind) {
    this.invalidate(kind);
    this.emit('changed');
  }

  async rename(id: string, title: string): Promise<void> {
    const r = await this.resolve(id);
    const native = !!(r.source && r.nativeId && r.source.caps.rename && r.source.rename);
    const local = !!r.head && !r.head.imported;
    if (!native && !local) throw new Error(UNSUPPORTED);
    if (native) await r.source!.rename!(r.nativeId!, title);
    if (r.head) await this.transcripts.patchHead(id, { title });
    this.changed(r.kind);
  }

  async archive(ids: string[], archived: boolean): Promise<{ done: string[]; failed: { id: string; error: string }[] }> {
    const done: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const kinds = new Set<AgentKind>();
    for (const id of ids) {
      try {
        const r = await this.resolve(id);
        if (r.source && r.nativeId && r.source.caps.archive && r.source.archive) await r.source.archive(r.nativeId, archived);
        // Claude and claude-web's own sessions archive in meta (Claude Code has no archive flag)
        else if (r.kind === 'claude' || (r.head && !r.head.imported)) await this.meta.setSessionMeta(id, { archived });
        else throw new Error(UNSUPPORTED);
        kinds.add(r.kind);
        done.push(id);
      } catch (e: any) {
        failed.push({ id, error: e?.message ?? String(e) });
      }
    }
    if (done.length) { for (const k of kinds) this.invalidate(k); this.emit('changed'); }
    return { done, failed };
  }

  async fork(id: string): Promise<{ sessionId: string }> {
    const r = await this.resolve(id);
    if (!r.source || !r.nativeId || !r.source.caps.fork || !r.source.fork) throw new Error(UNSUPPORTED);
    const newNative = await r.source.fork(r.nativeId);
    this.changed(r.kind);
    return { sessionId: libraryId(r.kind, newNative) };
  }

  /**
   * Delete with a backup first: the full history is exported to library-trash/<id>.json (or, for a
   * source with backupTo — Claude — its raw files are copied to library-trash/<id>/), and only once
   * that is written is the session actually removed. Any export / copy / write failure → kept.
   */
  async remove(ids: string[]): Promise<{ removed: string[]; failed: { id: string; error: string }[] }> {
    const removed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const kinds = new Set<AgentKind>();
    for (const id of ids) {
      try {
        const r = await this.resolve(id);
        const native = !!(r.source && r.nativeId && r.source.caps.delete && r.source.remove);
        const local = !!r.head;
        if (!native && (!local || r.head!.imported)) throw new Error(UNSUPPORTED);
        const safe = id.replace(/[^\w.~-]/g, '_');
        const base = { id, agent: r.kind, nativeId: r.nativeId, deletedAt: Date.now(), summary: this.byId.get(id), local: local ? await this.transcripts.load(id) : undefined };
        await fs.mkdir(this.trashDir, { recursive: true });
        if (native && r.source!.backupTo) {
          // raw files (Claude: the jsonl plus the <id>/ dir its delete also removes) → library-trash/<id>/
          const dest = path.join(this.trashDir, safe);
          await fs.mkdir(dest, { recursive: true });
          await r.source!.backupTo(r.nativeId!, dest);
          await fs.writeFile(path.join(dest, 'backup.json'), JSON.stringify(base), 'utf8');
        } else {
          const backup = { ...base, native: native ? (r.source!.exportAll ? await r.source!.exportAll(r.nativeId!) : await this.readAll(id)) : undefined };
          await fs.writeFile(path.join(this.trashDir, `${safe}.json`), JSON.stringify(backup), 'utf8');
        }
        if (native) await r.source!.remove!(r.nativeId!);
        if (local) await this.transcripts.remove(id);
        this.index.remove(id);
        kinds.add(r.kind);
        removed.push(id);
      } catch (e: any) {
        failed.push({ id, error: e?.message ?? String(e) });
      }
    }
    if (removed.length) { for (const k of kinds) this.invalidate(k); this.emit('changed'); }
    return { removed, failed };
  }

  async cleanTrash(): Promise<void> {
    const names = await fs.readdir(this.trashDir).catch(() => [] as string[]);
    const cutoff = Date.now() - TRASH_KEEP_MS;
    for (const n of names) {
      const f = path.join(this.trashDir, n);
      const st = await fs.stat(f).catch(() => null);
      // <id>.json backups and <id>/ raw-copy directories alike
      if (st && st.mtimeMs < cutoff) await fs.rm(f, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Is `id` an IMPORTED session (its history lives in another agent's own store)? A head flagged
   * `imported`, or no head at all and a non-Claude library id. Returns the source agent and the
   * library summary's cwd / title (the head's as a fallback); null for Claude and claude-web's own.
   */
  async importedInfo(id: string): Promise<{ agent: AgentKind; cwd: string; title?: string } | null> {
    const head = await this.transcripts.head(id);
    if (head && !head.imported) return null;
    const route = parseLibraryId(id);
    if (!head && route.kind === 'claude') return null;
    let s = this.byId.get(id);
    if (!s) { await this.list(); s = this.byId.get(id); }
    const cwd = s?.cwd || head?.cwd;
    if (!cwd) throw new Error('会话库里找不到这个会话');
    return { agent: head?.agent ?? route.kind, cwd, title: s?.title ?? head?.title };
  }

  /**
   * Resuming an imported session: give it a claude-web head pointing at the native id, so the
   * existing Codex / ACP drivers take their resume branch (thread/resume, session/load).
   */
  prepareResume(id: string): Promise<{ agent: AgentKind; cwd: string }> {
    const running = this.resuming.get(id);
    if (running) return running;
    const p = (async () => {
      const head = await this.transcripts.head(id);
      if (head) return { agent: head.agent, cwd: head.cwd };
      let s = this.byId.get(id);
      if (!s) { await this.list(); s = this.byId.get(id); }
      const route = parseLibraryId(id);
      if (!s || route.kind === 'claude') throw new Error('会话库里找不到这个会话');
      if (!this.isJoined(route.kind)) throw new Error('该会话的来源未加入会话库');
      await this.transcripts.create({ sessionId: id, agent: route.kind, cwd: s.cwd, title: s.title, createdAt: s.createdAt ?? s.lastModified ?? Date.now(), nativeSessionId: route.nativeId, imported: true });
      return { agent: route.kind, cwd: s.cwd };
    })();
    this.resuming.set(id, p);
    return p.finally(() => this.resuming.delete(id));
  }

  // ---------- index / search ----------
  /** Re-index sessions whose lastModified moved; serial and yielding, so it never blocks requests. */
  refreshIndex(): Promise<void> {
    if (this.indexing) { this.indexAgain = true; return this.indexing; }
    this.indexing = (async () => {
      do {
        this.indexAgain = false;
        await this.list();
        const all = [...this.byId.values()]; // children too
        // every joined source that listed cleanly counts as indexed — including one with no sessions
        // (otherwise an empty source reads「尚未索引」forever)
        const done = new Set<AgentKind>(this.joinedSources().map((s) => s.kind).filter((k) => !this.errors.has(k) && !this.loading.has(k)));
        for (const s of all) {
          const kind = s.agent ?? 'claude';
          done.add(kind);
          if (this.index.indexedAt(s.sessionId) === s.lastModified) continue;
          try {
            const msgs = await this.readAll(s.sessionId);
            this.index.upsert({ ...s, agent: kind }, messagesText(msgs));
          } catch { /* retried on the next pass */ }
          await new Promise((r) => setImmediate(r));
        }
        // sessions deleted / left since the last pass
        // …but only for sources that listed successfully: a failed fetch looks like "no sessions"
        if (!this.localFailed) {
          for (const id of this.index.ids()) {
            const k = parseLibraryId(id).kind;
            if (this.byId.has(id) || this.errors.has(k) || this.loading.has(k)) continue;
            this.index.remove(id);
          }
        }
        const now = Date.now();
        for (const k of done) this.indexedAtByKind.set(k, now);
        this.indexReady = true;
      } while (this.indexAgain);
    })().finally(() => { this.indexing = null; });
    return this.indexing;
  }

  /** Debounced refresh (join, 'changed', file watchers). */
  scheduleIndex(delayMs = 5_000) {
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => { this.indexTimer = null; void this.refreshIndex().catch(() => {}); }, delayMs);
    this.indexTimer.unref?.();
  }

  async search(raw: string, limit = 30): Promise<{ session: SessionSummary; snippet?: string }[]> {
    const q = LibraryIndex.parseQuery(raw);
    if (!this.indexReady || this.index.count() === 0) {
      return this.opts.fallbackSearch ? this.opts.fallbackSearch(q.q, limit) : [];
    }
    if (!this.byId.size) await this.list();
    const hits = this.index.search(q.q, { limit, agent: q.agent, cwdLike: q.cwdLike });
    const out: { session: SessionSummary; snippet?: string }[] = [];
    for (const h of hits) {
      const s = this.byId.get(h.id);
      if (s) out.push({ session: s, snippet: h.snippet });
    }
    return out;
  }

  // ---------- lifecycle ----------
  /** Startup: trash cleanup, discovery, first index pass after 10 s, file watchers (joined sources only). */
  start(watchDirs: Partial<Record<AgentKind, string[]>> = defaultWatchDirs()) {
    void this.cleanTrash();
    void this.announce().catch(() => {});
    const t = setTimeout(() => { void this.refreshIndex().catch(() => {}); }, 10_000);
    t.unref?.();
    this.timers.push(t);
    this.on('changed', () => this.scheduleIndex());
    this.watchDirs = watchDirs;
    for (const k of Object.keys(watchDirs) as AgentKind[]) if (this.isJoined(k)) this.watch(k);
  }

  private watch(kind: AgentKind) {
    if (!this.watchDirs || this.watchers.has(kind)) return;
    const dirs = (this.watchDirs[kind] ?? []).filter((d) => existsSync(d));
    if (!dirs.length) return;
    const w = chokidar.watch(dirs, { ignoreInitial: true, depth: 4 });
    w.on('all', () => {
      // Claude's list comes from SessionService (its own watcher keeps it fresh); others revalidate
      if (kind !== 'claude') this.invalidate(kind, { soft: true });
      this.scheduleIndex();
    });
    w.on('error', () => {});
    this.watchers.set(kind, w);
  }

  private unwatch(kind: AgentKind) {
    const w = this.watchers.get(kind);
    if (!w) return;
    this.watchers.delete(kind);
    void w.close();
  }

  /** Stop timers / watchers (no source processes). */
  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.indexTimer) { clearTimeout(this.indexTimer); this.indexTimer = null; }
    for (const k of [...this.watchers.keys()]) this.unwatch(k);
    this.watchDirs = null;
  }

  /** Shutdown: dispose + close every source's library-only background process. */
  async close(): Promise<void> {
    this.dispose();
    await Promise.all([...this.srcs.values()].map((s) => s.close().catch(() => {})));
    this.index.close();
  }
}
