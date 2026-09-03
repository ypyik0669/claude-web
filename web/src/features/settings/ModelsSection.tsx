import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { CATALOG, modelsFor } from '@catalog';
import type { AgentKind } from '@shared';

const AGENTS: { kind: AgentKind; name: string }[] = [
  { kind: 'claude', name: 'Claude Code' },
  { kind: 'codex', name: 'Codex' },
  { kind: 'gemini', name: 'Gemini CLI' },
  { kind: 'qwen', name: 'Qwen Code' },
  { kind: 'kimi', name: 'Kimi CLI' },
];

/**
 * Per-model enable switches (`ui.disabledModels` hides a model from the composer's picker) plus the
 * effort ladder each agent actually supports. Everything here reads @catalog, so display names carry
 * their version and no agent is offered a rung it doesn't have.
 */
export function ModelsSection() {
  const disabled = useStore((s) => (s.settings['ui.disabledModels'] as string[] | undefined) ?? []);
  const setSetting = useStore((s) => s.setSetting);
  const providers = useStore((s) => s.providers);
  const toggle = (id: string) => void setSetting('ui.disabledModels', disabled.includes(id) ? disabled.filter((x) => x !== id) : [...disabled, id]);
  const row = (id: string, l: string, d?: string) => (
    <div key={id} className="row">
      <button className={clsx('toggle', !disabled.includes(id) && 'on')} role="switch" aria-checked={!disabled.includes(id)} aria-label={l} onClick={() => toggle(id)} />
      <div className="grow"><div>{l}</div>{d && <div className="sub">{d}</div>}</div>
    </div>
  );
  return (
    <>
      {AGENTS.map(({ kind, name }) => {
        const c = CATALOG[kind];
        const models = modelsFor(kind);
        return (
          <div key={kind} className="section">
            <h5><Icon name={AGENT_ICONS[kind] ?? 'agent'} size={13} /> {name}</h5>
            <div className="list">
              {models.map((m) => row(kind === 'claude' ? m.value : `${kind}:${m.value}`, m.displayName, m.description || undefined))}
              {!models.length && <div className="empty">{c?.unverified ? '模型表未核实' : '没有内置模型'}</div>}
            </div>
            <div className="efforts">
              {c?.supportsEffort && c.effort.length > 0 ? (
                <>
                  <span className="label">effort</span>
                  {c.effort.map((e) => <span key={e} className={clsx('badge', e === c.defaultEffort && 'ok')} title={e === c.defaultEffort ? '默认' : undefined}>{e}</span>)}
                  {c.supportsUltracode && <span className="badge" title="xhigh + 动态工作流编排，会话级；不是一个 effort 等级"><Icon name="bolt" size={10} /> ultracode</span>}
                </>
              ) : (
                <span className="sub">没有 effort 开关</span>
              )}
            </div>
            {c?.note && <div className="sub" style={{ padding: '2px 4px' }}>{c.note}</div>}
          </div>
        );
      })}
      {providers.map((p) => (
        <div key={p.id} className="section">
          <h5><Icon name="cloud" size={13} /> {p.name} <span className="badge">{p.type}</span></h5>
          <div className="list">
            {(p.models ?? []).map((m) => row(`${p.id}:${m}`, m, p.defaultModel === m ? '默认' : undefined))}
            {!(p.models ?? []).length && <div className="empty">在「供应商」里探测一次拿到模型列表</div>}
          </div>
        </div>
      ))}
      <div className="sub" style={{ padding: '0 4px' }}>关掉的模型不再出现在新会话的模型选择里；会话内 /model 仍可切换。模型表与 effort 等级来自 <code>server/src/models/catalog.ts</code>，agent 自己上报的列表优先。</div>
    </>
  );
}
