import { useStore } from '@/store';
import { clsx } from '@/util';

const CLAUDE_MODELS = [
  { id: 'fable', l: 'Fable', d: 'Claude Fable 5.1 — 最强，慢、贵' },
  { id: 'opus', l: 'Opus', d: 'Claude Opus 5 — 复杂任务' },
  { id: 'sonnet', l: 'Sonnet', d: 'Claude Sonnet 5 — 日常编码' },
  { id: 'haiku', l: 'Haiku', d: 'Claude Haiku 4.5 — 快、便宜' },
];

/** Per-model enable switches: disabled models are hidden from the composer's picker (`ui.disabledModels`). */
export function ModelsSection() {
  const disabled = useStore((s) => (s.settings['ui.disabledModels'] as string[] | undefined) ?? []);
  const setSetting = useStore((s) => s.setSetting);
  const providers = useStore((s) => s.providers);
  const toggle = (id: string) => void setSetting('ui.disabledModels', disabled.includes(id) ? disabled.filter((x) => x !== id) : [...disabled, id]);
  const row = (id: string, l: string, d?: string) => (
    <div key={id} className="row">
      <button className={clsx('toggle', !disabled.includes(id) && 'on')} onClick={() => toggle(id)} />
      <div className="grow"><div>{l}</div>{d && <div className="sub">{d}</div>}</div>
    </div>
  );
  return (
    <>
      <div className="section">
        <h5>Claude 账号</h5>
        <div className="list">{CLAUDE_MODELS.map((m) => row(m.id, m.l, m.d))}</div>
      </div>
      {providers.map((p) => (
        <div key={p.id} className="section">
          <h5>{p.name} <span className="badge">{p.type}</span></h5>
          <div className="list">
            {(p.models ?? []).map((m) => row(`${p.id}:${m}`, m, p.defaultModel === m ? '默认' : undefined))}
            {!(p.models ?? []).length && <div className="empty">在「供应商」里探测一次拿到模型列表</div>}
          </div>
        </div>
      ))}
      <div className="sub" style={{ padding: '0 4px' }}>关掉的模型不再出现在新会话的模型选择里；会话内 /model 仍可切换。</div>
    </>
  );
}
