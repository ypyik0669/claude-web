import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { basename, clsx } from '@/util';
import type { PermissionRequestEvent, PermissionResponse } from '@shared';
import { DiffView, Markdown } from './Markdown';
import { CodeBlock } from './CodeBlock';
import { langFromPath } from './highlight';
import { JsonTree } from './tools/McpTool';
import { Icon } from '@/ui/icons';
import { DOCK_HINT } from '@/ui/terms';
import { alwaysDetails, alwaysLabel, denyResponse, dockKind, permissionTitle, primaryKey } from './permission-dock';

// The card a permission request, an AskUserQuestion or an ExitPlanMode docks above the composer (redesign phase 5,
// spec §5.3 / §5.11): one at a time, 「还有 N 条」 when more wait. The old 「拒绝理由 / 修改意见」 field is the composer
// itself — sending there denies with those words (Composer + `dockAction`), and an empty Enter is this card's main
// button, registered here by the composer's pane + request id. Mission Control, IM and the sidebar answer through
// the same `respondPermission`; a request answered there disappears here on `permission.resolved`.

/** The main button of each docked card (允许一次 / 批准并开始 / 提交回答), for the composer's empty Enter. */
const primaries = new Map<string, () => boolean>();
/** Press the docked card's main button (`key` = `primaryKey(scope, requestId)`); false when it cannot go yet (a question with no answer picked). */
export function runDockPrimary(key: string): boolean {
  return primaries.get(key)?.() ?? false;
}
function usePrimary(scope: string, requestId: string, fn: () => boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const key = primaryKey(scope, requestId);
    const f = () => ref.current();
    primaries.set(key, f);
    return () => { if (primaries.get(key) === f) primaries.delete(key); };
  }, [scope, requestId]);
}

/** One answer per request: the buttons stay disabled until the server says it is resolved (or it failed). */
function useRespond(p: PermissionRequestEvent) {
  const respond = useStore((s) => s.respondPermission);
  const [busy, setBusy] = useState(false);
  const send = (r: PermissionResponse) => {
    if (busy) return false;
    setBusy(true);
    void respond(p.requestId, r).finally(() => setBusy(false));
    return true;
  };
  return { busy, send };
}

interface CardProps { p: PermissionRequestEvent; agent: string; cwd: string; more: number; reason: string; onReasonUsed: () => void; scope: string; note?: string }

/** The line left of the buttons: the hint (the composer is where another instruction goes), or the composer's note about what Enter will do now. */
const Hint = ({ hint, note }: { hint: string; note?: string }) => (note ? <span className="pd-hint note" role="status">{note}</span> : <span className="pd-hint">{hint}</span>);

function Head({ p, agent, more, where }: { p: PermissionRequestEvent; agent: string; more: number; where?: string }) {
  const kind = dockKind(p);
  return (
    <div className="pd-head">
      <Icon name={kind === 'ask' ? 'question' : kind === 'plan' ? 'plan' : 'shield'} size={15} className="pd-ic" />
      <span className="pd-title">{permissionTitle(p, agent)}</span>
      {more > 0 && <span className="pd-more" title="其它请求排在这一条后面，一次处理一条">还有 {more} 条</span>}
      <span className="grow" />
      {where && <span className="pd-where" title={where}><Icon name="folder" size={12} />{basename(where)}</span>}
    </div>
  );
}

/** Enter in an empty composer = this; the ↵ on the button says so. */
const Enter = () => <kbd className="pd-kbd" aria-hidden>↵</kbd>;

function ToolPermission({ p, agent, cwd, more, reason, onReasonUsed, scope, note }: CardProps) {
  const { busy, send } = useRespond(p);
  const inp = p.input as Record<string, any>;
  const allowOnce = () => send({ behavior: 'allow' });
  usePrimary(scope, p.requestId, allowOnce);
  const always = alwaysLabel(p.suggestions);
  const deny = () => { if (send(denyResponse(p, reason)) && reason.trim()) onReasonUsed(); };
  const shell = p.toolName === 'Bash' || p.toolName === 'PowerShell';
  const edit = p.toolName === 'Edit' || p.toolName === 'MultiEdit';
  return (
    <>
      <Head p={p} agent={agent} more={more} where={cwd} />
      <div className="pd-body">
        {shell ? (
          <>
            <div className="pd-cmd"><span className="ps" aria-hidden>{p.toolName === 'PowerShell' ? '>' : '$'}</span><code>{String(inp.command ?? '')}</code></div>
            {inp.description && <div className="pd-note">{String(inp.description)}</div>}
          </>
        ) : edit ? (
          <div className="pd-scroll">{(p.toolName === 'MultiEdit' ? inp.edits ?? [] : [inp]).map((e: any, i: number) => <DiffView key={i} oldText={String(e.old_string ?? '')} newText={String(e.new_string ?? '')} title={String(inp.file_path ?? '')} collapse={false} />)}</div>
        ) : p.toolName === 'Write' ? (
          <div className="pd-scroll"><CodeBlock code={String(inp.content ?? '')} lang={langFromPath(String(inp.file_path ?? ''))} title={String(inp.file_path ?? '')} maxLines={40} /></div>
        ) : (
          <div className="pd-scroll jt"><JsonTree value={p.input} /></div>
        )}
        {p.decisionReason && <div className="pd-note">{p.decisionReason}</div>}
      </div>
      <div className="pd-actions">
        <Hint hint={DOCK_HINT.tool(agent)} note={note} />
        <button className="btn" data-act="deny" disabled={busy} onClick={deny} title={reason.trim() ? `拒绝，并把输入框里的话告诉 ${agent}` : '拒绝这次操作'}>拒绝</button>
        {always && <button className="btn" data-act="always" disabled={busy} title={`允许，并写进权限规则，之后同样的操作不再询问：\n${alwaysDetails(p.suggestions).join('\n')}`} onClick={() => send({ behavior: 'allow', updatedPermissions: p.suggestions })}>{always}</button>}
        <button className="btn primary pd-main" data-act="allow" disabled={busy} onClick={allowOnce} title="允许这一次（输入框空着时按 Enter 也是）">允许一次 <Enter /></button>
      </div>
    </>
  );
}

function PlanApproval({ p, agent, more, reason, onReasonUsed, scope, note }: CardProps) {
  const { busy, send } = useRespond(p);
  const approve = () => send({ behavior: 'allow', updatedInput: p.input });
  // Ctrl+Enter only (the composer decides): a plan is long, an Enter while reading it must not start the work
  usePrimary(scope, p.requestId, approve);
  const revise = () => { if (send(denyResponse(p, reason)) && reason.trim()) onReasonUsed(); };
  return (
    <>
      <Head p={p} agent={agent} more={more} />
      <div className="pd-body"><div className="pd-scroll pd-plan"><Markdown text={String(p.input.plan ?? '')} /></div></div>
      <div className="pd-actions">
        <Hint hint={DOCK_HINT.plan()} note={note} />
        <button className="btn" data-act="deny" disabled={busy} onClick={revise} title={reason.trim() ? '把输入框里的修改意见发给 Claude' : '要求修改计划'}>要求修改</button>
        <button className="btn primary pd-main" data-act="allow" disabled={busy} onClick={approve} title="批准并开始（输入框空着时按 Ctrl+Enter 也是）">批准并开始 <kbd className="pd-kbd" aria-hidden>Ctrl ↵</kbd></button>
      </div>
    </>
  );
}

function AskQuestion({ p, agent, more, reason, onReasonUsed, scope, note }: CardProps) {
  const { busy, send } = useRespond(p);
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
  const complete = qs.every((q) => (sel[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());
  const submit = () => {
    if (!complete) return false;
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const o = other[q.question]?.trim();
      const chosen = sel[q.question] ?? [];
      answers[q.question] = o ? [...chosen, o].join(', ') : chosen.join(', ');
    }
    return send({ behavior: 'allow', updatedInput: { ...p.input, answers } });
  };
  usePrimary(scope, p.requestId, submit);
  const skip = () => { if (send(denyResponse(p, reason)) && reason.trim()) onReasonUsed(); };
  return (
    <>
      <Head p={p} agent={agent} more={more} />
      <div className="pd-body pd-scroll">
        {qs.map((q) => (
          <div key={q.question} className="pd-q">
            <div className="pd-qt">{q.header && <span className="badge">{q.header}</span>} {q.question}</div>
            {q.options.map((o: any) => {
              const on = !!sel[q.question]?.includes(o.label);
              return (
                <button key={o.label} className={clsx('q-opt', on && 'sel')} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => toggle(q, o.label)}>
                  <span className="opt-mark"><Icon name={on ? 'checkCircle' : 'circle'} size={14} /></span>
                  <span className="q-txt">
                    <span className="q-l">{o.label}</span>
                    {o.description && <span className="d">{o.description}</span>}
                    {o.preview && <pre>{o.preview}</pre>}
                  </span>
                </button>
              );
            })}
            <input className="pd-other" placeholder="其它（自定义回答）" value={other[q.question] ?? ''} onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className="pd-actions">
        <Hint hint={DOCK_HINT.ask(agent)} note={note} />
        <button className="btn" data-act="deny" disabled={busy} onClick={skip}>跳过</button>
        <button className="btn primary pd-main" data-act="allow" disabled={busy || !complete} onClick={submit} title="提交回答（选好之后在空输入框按 Enter 也是）">提交回答 <Enter /></button>
      </div>
    </>
  );
}

/**
 * The first pending request of this conversation, docked above its composer (it replaces the run card while it is
 * there). `reason`: what is typed in the composer — 拒绝 / 要求修改 / 跳过 send it as the reason, then `onReasonUsed`
 * clears the box. `scope`: the composer's pane + tile (the main button is registered per pane). `note`: what Enter
 * will do now, when that is not the usual (words from before the card, queued words, attachments).
 */
export function PermissionDock({ sessionId, reason, onReasonUsed, scope, note }: { sessionId: string; reason: string; onReasonUsed: () => void; scope: string; note?: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const p = o?.pending[0];
  if (!o || !p) return null;
  const agent = o.info?.agent && o.info.agent !== 'claude' ? o.info.agentName ?? o.info.agent : 'Claude';
  const props: CardProps = { p, agent, cwd: o.cwd, more: o.pending.length - 1, reason, onReasonUsed, scope, note };
  const kind = dockKind(p);
  return (
    <div className={clsx('pdock', kind)} role="region" aria-label={permissionTitle(p, agent)} data-request={p.requestId} data-kind={kind}>
      {kind === 'ask' ? <AskQuestion key={p.requestId} {...props} /> : kind === 'plan' ? <PlanApproval key={p.requestId} {...props} /> : <ToolPermission key={p.requestId} {...props} />}
    </div>
  );
}
