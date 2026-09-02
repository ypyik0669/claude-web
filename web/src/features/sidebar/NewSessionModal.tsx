import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import type { EffortLevel, PermissionMode } from '@shared';

const MODES: { v: PermissionMode; l: string }[] = [
  { v: 'default', l: '默认（每次询问）' },
  { v: 'acceptEdits', l: '自动接受文件编辑' },
  { v: 'plan', l: '计划模式' },
  { v: 'auto', l: '自动模式' },
  { v: 'bypassPermissions', l: '跳过所有权限' },
  { v: 'dontAsk', l: '不询问（拒绝需确认的）' },
];

export function NewSessionModal({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const openSession = useStore((s) => s.openSession);
  const recent = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].slice(0, 12), [sessions]);
  const [cwd, setCwd] = useState(localStorage.getItem('cw.lastCwd') || recent[0] || '');
  const [model, setModel] = useState(localStorage.getItem('cw.lastModel') || '');
  const [mode, setMode] = useState<PermissionMode>((localStorage.getItem('cw.lastMode') as PermissionMode) || 'default');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const go = async () => {
    if (!cwd.trim()) return setErr('请填写工作目录');
    setBusy(true);
    setErr('');
    try {
      localStorage.setItem('cw.lastCwd', cwd);
      localStorage.setItem('cw.lastModel', model);
      localStorage.setItem('cw.lastMode', mode);
      await openSession({ cwd: cwd.trim(), model: model || undefined, permissionMode: mode, effort: effort || undefined });
      onClose();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const pick = async () => {
    const p = await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) setCwd(p);
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>新会话</h3>
        <label>工作目录</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input list="cw-dirs" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\\path\\to\\project" autoFocus onKeyDown={(e) => e.key === 'Enter' && go()} />
          <button className="btn" onClick={pick} title="选择文件夹">
            …
          </button>
        </div>
        <datalist id="cw-dirs">
          {recent.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        <label>模型（留空用默认）</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="fable / opus / sonnet / haiku 或完整模型名" list="cw-models" />
        <datalist id="cw-models">
          {['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5'].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <label>权限模式</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
          {MODES.map((m) => (
            <option key={m.v} value={m.v}>
              {m.l}
            </option>
          ))}
        </select>
        <label>Effort</label>
        <select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
          <option value="">默认</option>
          {['low', 'medium', 'high', 'xhigh', 'max'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {err && <div style={{ color: 'var(--red)', marginTop: 8, fontSize: 12 }}>{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={go} disabled={busy}>
            {busy ? '启动中…' : '开始'}
          </button>
        </div>
      </div>
    </div>
  );
}
