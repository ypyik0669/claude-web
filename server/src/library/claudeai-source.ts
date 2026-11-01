// claude.ai (stage F4): conversations imported from claude.ai's data export — a READ-ONLY library source. The import
// (import/claude-ai-service.ts) keeps one file per conversation under `<data>/claude-ai/conversations/<uuid>.json`;
// this source lists and reads them. 接着聊 goes on in a new Claude conversation seeded with the history
// (`continueInClaude`, the same way as DeepSeek Harness) — nothing ever goes back to claude.ai.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionSource } from './types.js';
import { libraryId } from './ids.js';
import { toSdkMessages, type ClaudeAiConversation } from '../import/claude-ai.js';
import { tr } from '../i18n/index.js';

const CAPS: SourceCaps = { resume: true, rename: false, archive: false, delete: false, fork: false, continueInClaude: true };

export interface StoredConversation { conv: ClaudeAiConversation; cwd?: string; importedAt: number }

export const conversationsDir = (root: string) => path.join(root, 'conversations');

export class ClaudeAiSource implements SessionSource {
  readonly kind: AgentKind = 'claudeai';
  readonly caps: SourceCaps = CAPS;
  private cache: { at: number; items: Map<string, StoredConversation> } | null = null;

  constructor(private readonly root: string) {}

  invalidate() { this.cache = null; }

  private async all(): Promise<Map<string, StoredConversation>> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.items;
    const items = new Map<string, StoredConversation>();
    let names: string[] = [];
    try { names = await fs.readdir(conversationsDir(this.root)); } catch { /* nothing imported */ }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(conversationsDir(this.root), n), 'utf8')) as StoredConversation;
        if (s?.conv?.uuid && Array.isArray(s.conv.messages)) items.set(s.conv.uuid, s);
      } catch { /* a broken file is skipped */ }
    }
    this.cache = { at: Date.now(), items };
    return items;
  }

  async status(): Promise<SourceStatus> {
    const n = (await this.all()).size;
    return { kind: this.kind, name: 'claude.ai', installed: n > 0, detected: n > 0, joined: false, enabled: n > 0, count: n };
  }

  async list(_o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[] }> {
    const items: SessionSummary[] = [];
    for (const s of (await this.all()).values()) {
      const c = s.conv;
      const first = c.messages.find((m) => m.sender === 'human');
      const firstPrompt = (first?.content.find((b: any) => b?.type === 'text')?.text ?? first?.text ?? '').trim();
      const updated = Date.parse(c.updatedAt) || s.importedAt;
      items.push({
        sessionId: libraryId('claudeai', c.uuid),
        title: c.name || firstPrompt.slice(0, 80) || tr('claude.ai 对话 {id}', { id: c.uuid.slice(0, 8) }),
        cwd: s.cwd || os.homedir(),
        lastModified: updated,
        createdAt: Date.parse(c.createdAt) || updated,
        ...(firstPrompt ? { firstPrompt: firstPrompt.slice(0, 500) } : {}),
        agent: this.kind,
        source: 'claude.ai',
        caps: CAPS,
      });
    }
    items.sort((a, b) => b.lastModified - a.lastModified);
    return { items };
  }

  /** Newest page first (`cursor` = where the next, older page ends), each page in order. */
  async read(nativeId: string, o: { cursor?: string; limit: number } = { limit: 50 }): Promise<{ messages: any[]; next?: string }> {
    const s = (await this.all()).get(nativeId);
    if (!s) throw new Error(tr('对话库里找不到这个对话'));
    const rows = toSdkMessages(s.conv, libraryId('claudeai', nativeId));
    const end = o.cursor !== undefined ? Math.min(rows.length, Math.max(0, Number(o.cursor) || 0)) : rows.length;
    const start = Math.max(0, end - Math.max(1, o.limit || 50));
    return { messages: rows.slice(start, end), ...(start > 0 ? { next: String(start) } : {}) };
  }

  async close(): Promise<void> { /* files only */ }
}
