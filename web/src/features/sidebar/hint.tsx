import { useState } from 'react';
import type { AgentKind, SourceStatus } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import type { HintId } from './entries';
import { hintText } from './newcomer';
import { tr } from '@/i18n';

/**
 * 「把 Codex 等工具里的对话也列在这里？」 as one quiet line above the account row (it used to be a card over the list),
 * shown once there is a conversation on this computer (`hintReady`, Sidebar: the first screen has the 入门清单). The
 * start page no longer has a copy (redesign 2026-11 stage 4: nothing stacked under the box).
 * 列出来 joins (one source
 * directly; several → 选择… which), × is 以后再说. Joining is opt-in; ignoring it changes nothing; settings → 对话库
 * manages the sources later.
 */
export function DiscoveryHint({ pending, home }: { pending: SourceStatus[]; home?: boolean }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const apply = (r: SourceStatus[] | null) => { if (Array.isArray(r)) useStore.setState({ librarySources: r }); };
  const join = async (k: AgentKind) => {
    setBusy(k);
    try { apply(await ws.request<SourceStatus[]>({ kind: 'library.join', kind_: k, joined: true })); } catch (e: any) { toast(e.message); } finally { setBusy(null); }
  };
  const later = async () => {
    setBusy('later');
    try { for (const p of pending) apply(await ws.request<SourceStatus[]>({ kind: 'library.dismiss', kind_: p.kind })); } catch (e: any) { toast(e.message); } finally { setBusy(null); }
  };
  // the home page's copy has no ids: the sidebar entry table (entries.ts) is about the sidebar
  const id = (x: HintId) => (home ? undefined : x);
  const t = hintText(pending.map((p) => p.name));
  return (
    <div className={home ? 'sb-hint home-hint' : 'sb-hint'} role="status">
      <div className="line">
        <Icon name="info" size={13} />
        <span className="msg" title={t.title}>{t.text}</span>
        <button className="link" data-id={id('library-join')} disabled={!!busy} aria-expanded={pending.length > 1 ? pick : undefined} onClick={() => (pending.length === 1 ? void join(pending[0].kind) : setPick(!pick))}>
          {busy && busy !== 'later' && pending.length === 1 ? <span className="spinner" /> : pending.length > 1 ? tr('选择…') : tr('列出来')}
        </button>
        <button className="icon-btn xs" data-id={id('library-later')} title={tr('以后再说（设置 → 对话库 里随时可以加入）')} aria-label={tr('以后再说')} disabled={!!busy} onClick={later}><Icon name="close" size={12} /></button>
      </div>
      {pick && pending.length > 1 && (
        <div className="picks">
          {pending.map((p) => (
            <button key={p.kind} className="btn sm" disabled={!!busy} onClick={() => join(p.kind)}>
              {busy === p.kind ? <span className="spinner" /> : <Icon name={AGENT_ICONS[p.kind] ?? 'agent'} size={12} />} {tr('列出 {name}', { name: p.name })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
