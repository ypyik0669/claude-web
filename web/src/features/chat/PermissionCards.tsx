import { useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { clsx, toolSummary } from '@/util';
import type { PermissionRequestEvent } from '@shared';
import { DiffView, Markdown } from './Markdown';
import { CodeBlock } from './CodeBlock';
import { langFromPath } from './highlight';
import { JsonTree } from './tools/McpTool';
import { Icon } from '@/ui/icons';

function AskQuestion({ p }: { p: PermissionRequestEvent }) {
  const respond = useStore((s) => s.respondPermission);
  const qs: any[] = (p.input.questions as any[]) ?? [];
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: any, label: string) => {
    setSel((s) => {
      const cur = s[q.question] ?? [];
      if (q.multiSelect) return { ...s, [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      return { ...s, [q.question]: [label] };
    });
  };
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const o = other[q.question]?.trim();
      const chosen = sel[q.question] ?? [];
      answers[q.question] = o ? [...chosen, o].join(', ') : chosen.join(', ');
    }
    void respond(p.requestId, { behavior: 'allow', updatedInput: { ...p.input, answers } });
  };
  const complete = qs.every((q) => (sel[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());
  return (
    <div className="perm">
      <h4><Icon name="question" size={15} /> Claude 有问题要问你</h4>
      {qs.map((q) => (
        <div key={q.question} style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}>
            <span className="badge">{q.header}</span> {q.question}
          </div>
          {q.options.map((o: any) => (
            <div key={o.label} className={clsx('q-opt', sel[q.question]?.includes(o.label) && 'sel')} onClick={() => toggle(q, o.label)}>
              <span className="opt-mark"><Icon name={sel[q.question]?.includes(o.label) ? 'checkCircle' : 'circle'} size={14} /></span>
              <div style={{ flex: 1 }}>
                <div>{o.label}</div>
                <div className="d">{o.description}</div>
                {o.preview && <pre>{o.preview}</pre>}
              </div>
            </div>
          ))}
          <input placeholder="其它（自定义回答）" value={other[q.question] ?? ''} onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))} style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: '5px 8px', marginTop: 4 }} />
        </div>
      ))}
      <div className="actions">
        <button className="btn primary" disabled={!complete} onClick={submit}>
          提交回答
        </button>
        <button className="btn" onClick={() => respond(p.requestId, { behavior: 'deny', message: '用户取消了提问' })}>
          取消
        </button>
      </div>
    </div>
  );
}

function PlanApproval({ p }: { p: PermissionRequestEvent }) {
  const respond = useStore((s) => s.respondPermission);
  const [msg, setMsg] = useState('');
  return (
    <div className="perm">
      <h4><Icon name="plan" size={15} /> Claude 请求批准计划并开始实施</h4>
      <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 12px', background: 'var(--bg)' }}>
        <Markdown text={String(p.input.plan ?? '')} />
      </div>
      <div className="actions">
        <button className="btn primary" onClick={() => respond(p.requestId, { behavior: 'allow', updatedInput: p.input })}>
          批准并开始
        </button>
        <input placeholder="修改意见（拒绝时回传给 Claude）" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className="btn" onClick={() => respond(p.requestId, { behavior: 'deny', message: msg || '用户要求修改计划' })}>
          要求修改
        </button>
      </div>
    </div>
  );
}

function ToolPermission({ p }: { p: PermissionRequestEvent }) {
  const respond = useStore((s) => s.respondPermission);
  const [msg, setMsg] = useState('');
  const inp = p.input as any;
  const isEdit = p.toolName === 'Edit' || p.toolName === 'MultiEdit';
  return (
    <div className="perm">
      <h4>
        <Icon name="lock" size={13} /> 需要权限：<span className="mono">{p.toolName}</span>
        <span style={{ color: 'var(--fg-2)', fontWeight: 400, fontSize: 12 }}>{toolSummary(p.toolName, p.input)}</span>
      </h4>
      {p.decisionReason && <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 6 }}>{p.decisionReason}</div>}
      {isEdit ? (
        (p.toolName === 'MultiEdit' ? inp.edits ?? [] : [inp]).map((e: any, i: number) => <DiffView key={i} oldText={String(e.old_string ?? '')} newText={String(e.new_string ?? '')} title={String(inp.file_path ?? '')} collapse={false} />)
      ) : p.toolName === 'Write' ? (
        <CodeBlock code={String(inp.content ?? '')} lang={langFromPath(String(inp.file_path ?? ''))} title={String(inp.file_path ?? '')} maxLines={60} />
      ) : p.toolName === 'Bash' || p.toolName === 'PowerShell' ? (
        <CodeBlock code={String(inp.command ?? '')} lang={p.toolName === 'PowerShell' ? 'powershell' : 'bash'} title={inp.description ? String(inp.description) : '命令'} wrap />
      ) : (
        <div className="jt" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}><JsonTree value={p.input} /></div>
      )}
      <div className="actions">
        <button className="btn primary" onClick={() => respond(p.requestId, { behavior: 'allow' })}>
          允许一次
        </button>
        {p.suggestions?.length ? (
          <button className="btn" title="写入权限规则，本会话不再询问" onClick={() => respond(p.requestId, { behavior: 'allow', updatedPermissions: p.suggestions })}>
            总是允许
          </button>
        ) : null}
        <input placeholder="拒绝理由 / 告诉 Claude 该怎么做" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && respond(p.requestId, { behavior: 'deny', message: msg || '用户拒绝' })} />
        <button className="btn danger" onClick={() => respond(p.requestId, { behavior: 'deny', message: msg || '用户拒绝了这次操作' })}>
          拒绝
        </button>
      </div>
    </div>
  );
}

export function PermissionCards() {
  const active = useScopedSession();
  if (!active?.pending.length) return null;
  return (
    <>
      {active.pending.map((p) => (p.toolName === 'AskUserQuestion' ? <AskQuestion key={p.requestId} p={p} /> : p.toolName === 'ExitPlanMode' ? <PlanApproval key={p.requestId} p={p} /> : <ToolPermission key={p.requestId} p={p} />))}
    </>
  );
}
