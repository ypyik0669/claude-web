import { useState } from 'react';
import type { AgentKind, SourceStatus } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import type { HintId } from './entries';

/**
 * 「Codex / OpenCode conversations were found on this machine — add them?」 as one quiet line above the account row
 * (it used to be a card over the list). 加入 joins (one source directly; several → pick which), × is 以后再说.
 * Joining is opt-in; ignoring it changes nothing; settings → 对话库 manages the sources later.
 */
export function DiscoveryHint({ pending }: { pending: SourceStatus[] }) {
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
  const id = (x: HintId) => x;
  const names = pending.map((p) => p.name).join('、');
  return (
    <div className="sb-hint" role="status">
      <div className="line">
        <Icon name="info" size={13} />
        <span className="msg" title={`检测到本机有 ${names} 的对话；加入后它们会出现在侧栏和搜索里（不会改动它们的数据）`}>发现 {names} 的对话</span>
        <button className="link" data-id={id('library-join')} disabled={!!busy} aria-expanded={pending.length > 1 ? pick : undefined} onClick={() => (pending.length === 1 ? void join(pending[0].kind) : setPick(!pick))}>
          {busy && busy !== 'later' && pending.length === 1 ? <span className="spinner" /> : '加入'}{pending.length > 1 ? '…' : ''}
        </button>
        <button className="icon-btn xs" data-id={id('library-later')} title="以后再说（设置 → 对话库 里随时可以加入）" aria-label="以后再说" disabled={!!busy} onClick={later}><Icon name="close" size={12} /></button>
      </div>
      {pick && pending.length > 1 && (
        <div className="picks">
          {pending.map((p) => (
            <button key={p.kind} className="btn sm" disabled={!!busy} onClick={() => join(p.kind)}>
              {busy === p.kind ? <span className="spinner" /> : <Icon name={AGENT_ICONS[p.kind] ?? 'agent'} size={12} />} 加入 {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
