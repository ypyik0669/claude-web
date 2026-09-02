import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantItem, Block, Item, ToolUseBlock } from '@/model/conversation';
import { useActive, useStore } from '@/store';
import { clsx, fmtMs, fmtTok, fmtUsd } from '@/util';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { PermissionCards } from './PermissionCards';

const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'AskUserQuestion', 'ExitPlanMode']);

/** Human summary for a run of consecutive tool calls, Claude-Code-on-web style: "读取 2 个文件 · 运行 1 条命令". */
function stepLabel(tools: ToolUseBlock[]): string {
  const c: Record<string, number> = {};
  for (const t of tools) {
    const k = t.name === 'Read' || t.name === 'Glob' || t.name === 'Grep' ? 'read' : t.name === 'Edit' || t.name === 'MultiEdit' || t.name === 'Write' || t.name === 'NotebookEdit' ? 'edit' : t.name === 'Bash' || t.name === 'PowerShell' ? 'cmd' : t.name === 'WebFetch' || t.name === 'WebSearch' ? 'web' : t.name === 'Skill' ? 'skill' : t.name.startsWith('mcp__') ? 'mcp' : 'other';
    c[k] = (c[k] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (c.read) parts.push(`读取 ${c.read} 个文件`);
  if (c.edit) parts.push(`编辑 ${c.edit} 个文件`);
  if (c.cmd) parts.push(`运行 ${c.cmd} 条命令`);
  if (c.web) parts.push(`搜索网页 ${c.web} 次`);
  if (c.skill) parts.push(`调用 ${c.skill} 个 skill`);
  if (c.mcp) parts.push(`MCP ${c.mcp} 次`);
  if (c.other) parts.push(`${c.other} 步`);
  return parts.join(' · ');
}

type Seg = { kind: 'text'; b: Block; i: number } | { kind: 'thinking'; b: Block; i: number } | { kind: 'agent'; t: ToolUseBlock } | { kind: 'steps'; tools: ToolUseBlock[] };

function segment(blocks: Block[]): Seg[] {
  const out: Seg[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'text') { if (b.text.trim() || i === blocks.length - 1) out.push({ kind: 'text', b, i }); }
    else if (b.type === 'thinking') { if (b.thinking || i === blocks.length - 1) out.push({ kind: 'thinking', b, i }); }
    else if (AGENT_TOOLS.has(b.name)) out.push({ kind: 'agent', t: b });
    else {
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.tools.push(b);
      else out.push({ kind: 'steps', tools: [b] });
    }
  });
  return out;
}

function Steps({ tools, version, live }: { tools: ToolUseBlock[]; version: number; live: boolean }) {
  const running = tools.some((t) => t.status === 'running' || t.status === 'pending' || t.status === 'streaming');
  const failed = tools.some((t) => t.status === 'error');
  const [open, setOpen] = useState<boolean | null>(null);
  const show = open ?? (live && running);
  return (
    <div className="step">
      <div className={clsx('step-head', show && 'open')} onClick={() => setOpen(!show)}>
        <span className="chev">▶</span>
        <span className="lbl">{stepLabel(tools)}</span>
        {running && <span className="spinner" />}
        {failed && <span className="badge err">失败</span>}
      </div>
      {show && (
        <div className="step-body">
          {tools.map((t) => (
            <ToolCard key={t.id} t={t} version={version} />
          ))}
        </div>
      )}
    </div>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text && !streaming) return null;
  return (
    <div className="step">
      <div className={clsx('step-head', open && 'open')} onClick={() => setOpen(!open)}>
        <span className="chev">▶</span>
        <span className="lbl">{streaming ? '思考中' : text.length > 1200 ? '深入思考了一会儿' : '思考了一下'}</span>
        {streaming && <span className="spinner" />}
      </div>
      {open && (
        <div className="step-body">
          <div className="thinking-body">{text}</div>
        </div>
      )}
    </div>
  );
}

const Assistant = memo(function Assistant({ it, version, live }: { it: AssistantItem; version: number; live: boolean }) {
  const segs = useMemo(() => segment(it.blocks), [it.blocks, version]);
  return (
    <div className="msg assistant">
      {segs.map((s, idx) => {
        if (s.kind === 'text') return <div key={idx} className={clsx(it.streaming && idx === segs.length - 1 && 'cursor')}><Markdown text={(s.b as any).text} /></div>;
        if (s.kind === 'thinking') return <Thinking key={idx} text={(s.b as any).thinking} streaming={it.streaming && idx === segs.length - 1} />;
        if (s.kind === 'agent') return <ToolCard key={s.t.id} t={s.t} version={version} />;
        return <Steps key={idx} tools={s.tools} version={version} live={live} />;
      })}
      {it.error && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{it.error}</div>}
    </div>
  );
});

/** Merge runs of assistant items that carry only tool calls (the CLI emits one API message per tool call) so steps collapse into one row. */
function coalesce(items: Item[]): Item[] {
  const out: Item[] = [];
  const toolsOnly = (it: AssistantItem) => it.blocks.length > 0 && it.blocks.every((b) => b.type === 'tool_use' || (b.type === 'thinking' && !b.thinking));
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === 'assistant' && prev?.kind === 'assistant' && toolsOnly(it) && (toolsOnly(prev) || prev.blocks[prev.blocks.length - 1]?.type === 'tool_use') && !prev.streaming && !prev.error) {
      out[out.length - 1] = { ...prev, blocks: [...prev.blocks, ...it.blocks], streaming: it.streaming, usage: it.usage ?? prev.usage };
      continue;
    }
    out.push(it);
  }
  return out;
}

export function ItemList({ items, version, live = false }: { items: Item[]; version: number; live?: boolean }) {
  const merged = useMemo(() => coalesce(items), [items, version]);
  return (
    <>
      {merged.map((it) => {
        switch (it.kind) {
          case 'user':
            return (
              <div key={it.id} className={clsx('msg user', it.meta && 'meta')}>
                {!it.meta && !it.id.startsWith('local-') && (
                  <div className="hover-actions">
                    <button title="从这条消息之前分叉出新会话（Claude Code --resume-session-at）" onClick={() => { const st = useStore.getState(); if (st.activeId) void st.forkAt(st.activeId, it.id).catch((e) => st.toast(e.message)); }}>⑂ 从这里分叉</button>
                    <button title="复制" onClick={() => navigator.clipboard.writeText(it.text)}>⧉</button>
                  </div>
                )}
                <div className="bubble">
                  {it.text}
                  {it.images.map((src, i) => src && <img key={i} src={src} alt="" />)}
                </div>
              </div>
            );
          case 'assistant':
            return <Assistant key={it.id} it={it} version={version} live={live} />;
          case 'result':
            return (
              <div key={it.id} className={clsx('result-line', it.isError && 'err')}>
                {it.isError && <span>错误: {it.text}</span>}
                <span>{fmtMs(it.durationMs)}</span>
                <span>{it.numTurns} 步</span>
                <span>{fmtUsd(it.costUsd)}</span>
                {it.usage ? <span>↑{fmtTok((it.usage as any).input_tokens + (it.usage as any).cache_read_input_tokens)} ↓{fmtTok((it.usage as any).output_tokens)}</span> : null}
              </div>
            );
          case 'system':
            return (
              <div key={it.id} className={clsx('sysline', it.subtype === 'command' && 'cmd')}>
                {it.text}
              </div>
            );
        }
      })}
    </>
  );
}

export function ChatView() {
  const active = useActive();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const version = active?.version ?? 0;

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version]);

  if (!active) return null;
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const live = active.state === 'running' || active.state === 'waiting';

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      <div className="chat-inner">
        {active.loading && <div className="sysline"><span className="spinner" /> 加载历史…</div>}
        <ItemList items={active.conv.items} version={version} live={live} />
        {active.error && <div className="sysline" style={{ color: 'var(--red)' }}>{active.error}</div>}
        <PermissionCards />
        {active.state === 'running' && !active.conv.streaming.size && (
          <div className="working">
            <span className="spinner" /> 处理中
          </div>
        )}
        {active.state === 'starting' && (
          <div className="working">
            <span className="spinner" /> 正在启动 Claude Code…
          </div>
        )}
      </div>
    </div>
  );
}
