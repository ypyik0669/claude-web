import { memo, useEffect, useRef } from 'react';
import type { AssistantItem, Item } from '@/model/conversation';
import { useActive } from '@/store';
import { clsx, fmtMs, fmtTok, fmtUsd } from '@/util';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { PermissionCards } from './PermissionCards';

const Assistant = memo(function Assistant({ it, version }: { it: AssistantItem; version: number }) {
  return (
    <div className="msg assistant">
      {it.blocks.map((b, i) => {
        if (b.type === 'text') return <div key={i} className={clsx(it.streaming && i === it.blocks.length - 1 && 'cursor')}><Markdown text={b.text} /></div>;
        if (b.type === 'thinking') {
          if (!b.thinking && !it.streaming) return null;
          return (
            <details key={i} className="thinking">
              <summary>
                <span>💭</span> 思考{it.streaming && i === it.blocks.length - 1 ? '中…' : ''} <span style={{ opacity: 0.6 }}>({b.thinking.length} 字)</span>
              </summary>
              <div className="body">{b.thinking}</div>
            </details>
          );
        }
        return <ToolCard key={b.id} t={b} version={version} />;
      })}
      {it.error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{it.error}</div>}
    </div>
  );
});

export function ItemList({ items, version }: { items: Item[]; version: number }) {
  return (
    <>
      {items.map((it) => {
        switch (it.kind) {
          case 'user':
            return (
              <div key={it.id} className={clsx('msg user', it.meta && 'meta')}>
                <div className="bubble">
                  {it.text}
                  {it.images.map((src, i) => src && <img key={i} src={src} alt="" />)}
                </div>
              </div>
            );
          case 'assistant':
            return <Assistant key={it.id} it={it} version={version} />;
          case 'result':
            return (
              <div key={it.id} className={clsx('result-line', it.isError && 'err')}>
                {it.isError && <span>错误: {it.text}</span>}
                <span>⏱ {fmtMs(it.durationMs)}</span>
                <span>API {fmtMs(it.apiMs)}</span>
                <span>{it.numTurns} 轮</span>
                <span>{fmtUsd(it.costUsd)}</span>
                {it.usage ? <span>in {fmtTok((it.usage as any).input_tokens)} · out {fmtTok((it.usage as any).output_tokens)} · cache {fmtTok((it.usage as any).cache_read_input_tokens)}</span> : null}
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

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      <div className="chat-inner">
        {active.loading && <div className="sysline">加载历史…</div>}
        <ItemList items={active.conv.items} version={version} />
        {active.error && <div className="sysline" style={{ color: 'var(--red)' }}>{active.error}</div>}
        <PermissionCards />
        {active.state === 'running' && !active.conv.streaming.size && <div className="sysline cursor">运行中</div>}
      </div>
    </div>
  );
}
