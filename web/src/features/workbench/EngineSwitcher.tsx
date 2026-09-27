import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { handOverMessage } from '@/features/sidebar/session-actions';
import type { AgentKind, SessionInfoSnapshot } from '@shared';

/**
 * Change what is driving a live session — a different provider profile, or a different agent —
 * without the user losing the session.
 *
 * Both are an invisible restart on the server (a CLI's env is fixed at spawn). The agent switch
 * additionally hands the new agent a briefing built from the neutral timeline, because it has no
 * native transcript for this session id. Reasoning never crosses; the briefing says so.
 */
export function EngineSwitcher({ sessionId, info }: { sessionId: string; info: SessionInfoSnapshot }) {
  const providers = useStore((s) => s.providers);
  const agents = useStore((s) => s.agents);
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const curAgent = (info.agent ?? 'claude') as AgentKind;
  const curProvider = info.providerId && info.providerId !== 'claude' ? info.providerId : '';
  const label = curAgent !== 'claude' ? info.agentName ?? curAgent : info.providerName ?? 'Claude 账号';

  const setProvider = async (providerId: string) => {
    setBusy(providerId || 'claude');
    try {
      await ws.request({ kind: 'session.setProvider', sessionId, providerId: providerId || undefined });
      toast('已切换供应商，会话继续', true);
      setOpen(false);
    } catch (e: any) { toast(e.message); } finally { setBusy(''); }
  };

  const switchAgent = async (agent: AgentKind) => {
    const a = agents.find((x) => x.kind === agent);
    const ok = await dlg.confirm(`把这个会话交给 ${a?.name ?? agent}？`, {
      message: handOverMessage(sessionId),
      okLabel: '交接',
    });
    if (!ok) return;
    setBusy(agent);
    try {
      const r = await ws.request<{ sessionId: string }>({ kind: 'session.switchAgent', sessionId, agent });
      toast(`已交接给 ${a?.name ?? agent}`, true);
      setOpen(false);
      // imported sessions hand over into a NEW session (the imported one stays as it was): open it
      if (r?.sessionId && r.sessionId !== sessionId) {
        const st = useStore.getState();
        await st.refreshSessions().catch(() => {});
        await st.loadHistory(r.sessionId, { mode: 'tab' });
      }
    } catch (e: any) { toast(e.message); } finally { setBusy(''); }
  };

  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button className={clsx('badge engine', open && 'active')} title="换供应商或换 agent，会话不中断" onClick={() => setOpen(!open)}>
        <Icon name={AGENT_ICONS[curAgent] ?? 'agent'} size={11} /> {label}
        <Icon name="chevronDown" size={9} />
      </button>
      {open && (
        <div className="menu engine-menu" style={{ top: 24, left: 0 }}>
          <div className="label" style={{ padding: '4px 10px 2px' }}>供应商（同一个 agent）</div>
          <button onClick={() => setProvider('')} disabled={!!busy}>
            <Icon name="claude" size={13} />
            <span style={{ flex: 1 }}>Claude 账号</span>
            {!curProvider && curAgent === 'claude' && <Icon name="check" size={13} />}
          </button>
          {providers.map((p) => (
            <button key={p.id} onClick={() => setProvider(p.id)} disabled={!!busy}>
              <Icon name="cloud" size={13} />
              <span style={{ flex: 1 }}>{p.name}</span>
              {curProvider === p.id && <Icon name="check" size={13} />}
            </button>
          ))}
          <div className="label" style={{ padding: '8px 10px 2px', borderTop: '1px solid var(--edge-subtle)', marginTop: 4 }}>换 agent（带交接说明）</div>
          {agents.filter((a) => a.installed !== false).map((a) => (
            <button key={a.kind} onClick={() => switchAgent(a.kind)} disabled={!!busy || a.kind === curAgent}>
              <Icon name={AGENT_ICONS[a.kind] ?? 'agent'} size={13} />
              <span style={{ flex: 1 }}>{a.name}</span>
              {a.kind === curAgent ? <Icon name="check" size={13} /> : busy === a.kind ? <span className="spinner" /> : null}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
