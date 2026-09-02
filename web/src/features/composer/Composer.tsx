import { useEffect, useMemo, useRef, useState } from 'react';
import { useActive, useStore } from '@/store';
import { fmtTok, fmtUsd, fmtMs, shortModel } from '@/util';

interface Img { mediaType: string; data: string; url: string }

export function Composer() {
  const active = useActive();
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const setDraft = useStore((s) => s.setDraft);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(active?.draft ?? '');
  const [imgs, setImgs] = useState<Img[]>([]);
  const [palIdx, setPalIdx] = useState(0);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [text]);

  const commands = active?.info?.slashCommands ?? [];
  const slashQuery = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const matches = useMemo(() => (slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 40)), [slashQuery, commands]);
  useEffect(() => setPalIdx(0), [slashQuery]);

  if (!active) return null;
  const busy = active.state === 'running' || active.state === 'waiting' || active.state === 'starting';
  const canSend = (text.trim().length > 0 || imgs.length > 0) && active.state !== 'starting';

  const doSend = async () => {
    if (!canSend) return;
    const t = text;
    const im = imgs;
    setText('');
    setImgs([]);
    setDraft(active.sessionId, '');
    await send(active.sessionId, t, im.map(({ mediaType, data }) => ({ mediaType, data })));
  };

  const pickCmd = (name: string) => {
    const c = commands.find((x) => x.name === name);
    setText(`/${name} ${c?.argumentHint ? '' : ''}`);
    ta.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && slashQuery !== null) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPalIdx((i) => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPalIdx((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text !== `/${matches[palIdx].name}`)) { e.preventDefault(); pickCmd(matches[palIdx].name); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void doSend();
    }
    if (e.key === 'Escape' && busy) void interrupt(active.sessionId);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    for (const f of Array.from(e.clipboardData.files)) {
      if (!f.type.startsWith('image/')) continue;
      const r = new FileReader();
      r.onload = () => {
        const url = String(r.result);
        setImgs((s) => [...s, { mediaType: f.type, data: url.split(',')[1], url }]);
      };
      r.readAsDataURL(f);
    }
  };

  const last = active.conv.lastResult;
  const totalUsage = (() => {
    let inp = 0, out = 0, cache = 0, cost = 0;
    for (const it of active.conv.items) {
      if (it.kind === 'assistant' && it.usage) { inp += it.usage.input; out += it.usage.output; cache += it.usage.cacheRead; }
      if (it.kind === 'result') cost += it.costUsd;
    }
    return { inp, out, cache, cost };
  })();

  return (
    <div className="composer">
      <div className="composer-inner">
        {matches.length > 0 && (
          <div className="palette">
            {matches.map((c, i) => (
              <div key={c.name} className={`it ${i === palIdx ? 'sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickCmd(c.name); }}>
                <span className="n">/{c.name} <span style={{ color: 'var(--fg-2)' }}>{c.argumentHint}</span></span>
                <span className="d">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        {active.queue.length > 0 && <div className="queue">已排队 {active.queue.length} 条，等当前轮结束后发送 · <button className="btn sm" onClick={() => useStore.setState((s) => ({ open: { ...s.open, [active.sessionId]: { ...active, queue: [] } } }))}>清空</button></div>}
        <div className="composer-box">
          {imgs.length > 0 && (
            <div className="attach">
              {imgs.map((im, i) => (
                <img key={i} src={im.url} alt="" onClick={() => setImgs((s) => s.filter((_, j) => j !== i))} title="点击移除" />
              ))}
            </div>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={active.state === 'history' ? '发送消息将继续这个会话…' : busy ? '运行中… 输入会排队，Esc 中断' : '输入消息，/ 查看命令，Shift+Enter 换行，可粘贴图片'}
            onChange={(e) => { setText(e.target.value); setDraft(active.sessionId, e.target.value); }}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          <div className="composer-bar">
            <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{active.info ? `${shortModel(active.info.model)}${active.info.effort ? ` · ${active.info.effort}` : ''}` : active.state === 'history' ? '历史会话（未运行）' : active.state}</span>
            <span className="grow" />
            {busy ? (
              <button className="send stop" title="中断 (Esc)" onClick={() => interrupt(active.sessionId)}>
                ■
              </button>
            ) : (
              <button className="send" disabled={!canSend} onClick={doSend} title="发送 (Enter)">
                ↑
              </button>
            )}
          </div>
        </div>
        <div className="statusbar">
          <span>{active.conv.items.filter((i) => i.kind === 'user' && !i.meta).length} 轮</span>
          <span>输入 {fmtTok(totalUsage.inp)} · 输出 {fmtTok(totalUsage.out)} · 缓存读 {fmtTok(totalUsage.cache)}</span>
          {totalUsage.cost > 0 && <span>{fmtUsd(totalUsage.cost)}</span>}
          {last && <span>上轮 {fmtMs(last.durationMs)}</span>}
          <span>{[...active.conv.tasks.values()].filter((t) => t.status === 'running').length} 后台任务</span>
        </div>
      </div>
    </div>
  );
}
