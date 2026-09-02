import { useEffect, useMemo, useRef, useState } from 'react';
import { useActive, useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx, fmtTok, fmtUsd, fmtMs, shortModel, basename } from '@/util';
import type { EffortLevel, PermissionMode } from '@shared';

interface Img { mediaType: string; data: string; url: string }

export const MODE_LABEL: Record<PermissionMode, string> = { default: '每次询问', acceptEdits: '自动接受编辑', plan: '计划模式', auto: '自动模式', bypassPermissions: '完全权限', dontAsk: '不询问' };
const MODEL_ALIASES = [
  { value: '', label: '默认模型' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

/**
 * The composer is used in two places: inside an open session (sends to it) and on the welcome screen
 * (creates a session on first send). `welcome` mode carries its own model/mode/cwd state.
 */
export function Composer({ welcome = false }: { welcome?: boolean }) {
  const active = useActive();
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const setDraft = useStore((s) => s.setDraft);
  const openSession = useStore((s) => s.openSession);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(welcome ? '' : active?.draft ?? '');
  const [imgs, setImgs] = useState<Img[]>([]);
  const [palIdx, setPalIdx] = useState(0);
  // welcome-mode settings
  const [cwd, setCwd] = useState(localStorage.getItem('cw.lastCwd') || sessions[0]?.cwd || '');
  const [wModel, setWModel] = useState(localStorage.getItem('cw.lastModel') || '');
  const [wMode, setWMode] = useState<PermissionMode>((localStorage.getItem('cw.lastMode') as PermissionMode) || 'default');
  const [wEffort, setWEffort] = useState<EffortLevel | ''>('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!cwd && sessions[0]?.cwd) setCwd(sessions[0].cwd);
  }, [sessions]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  }, [text]);

  useEffect(() => {
    if (welcome) ta.current?.focus();
  }, [welcome]);

  const commands = active?.info?.slashCommands ?? [];
  const slashQuery = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const matches = useMemo(() => (slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 40)), [slashQuery, commands]);
  useEffect(() => setPalIdx(0), [slashQuery]);

  const busy = !welcome && !!active && (active.state === 'running' || active.state === 'waiting' || active.state === 'starting');
  const canSend = (text.trim().length > 0 || imgs.length > 0) && !starting && (welcome || active?.state !== 'starting');

  const doSend = async () => {
    if (!canSend) return;
    const t = text;
    const im = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
    if (welcome) {
      if (!cwd.trim()) return toast('请先选择工作目录');
      setStarting(true);
      try {
        localStorage.setItem('cw.lastCwd', cwd);
        localStorage.setItem('cw.lastModel', wModel);
        localStorage.setItem('cw.lastMode', wMode);
        const id = await openSession({ cwd: cwd.trim(), model: wModel || undefined, permissionMode: wMode, effort: wEffort || undefined });
        await send(id, t, im);
      } catch (e: any) {
        toast(e.message);
      }
      setStarting(false);
      return;
    }
    if (!active) return;
    setText('');
    setImgs([]);
    setDraft(active.sessionId, '');
    try {
      await send(active.sessionId, t, im);
    } catch (e: any) {
      toast(e.message);
    }
  };

  const pickCmd = (name: string) => {
    setText(`/${name} `);
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
    if (e.key === 'Escape' && busy && active) void interrupt(active.sessionId);
  };

  const addFiles = (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const r = new FileReader();
      r.onload = () => {
        const url = String(r.result);
        setImgs((s) => [...s, { mediaType: f.type, data: url.split(',')[1], url }]);
      };
      r.readAsDataURL(f);
    }
  };
  const fileInput = useRef<HTMLInputElement>(null);

  const pickDir = async () => {
    const p = await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) setCwd(p);
  };

  // live controls
  const info = active?.info;
  const liveOk = !welcome && active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error' && info;
  const setMode = (mode: PermissionMode) => active && ws.request({ kind: 'session.setPermissionMode', sessionId: active.sessionId, mode }).catch((e) => toast(e.message));
  const setModel = (model: string) => active && ws.request({ kind: 'session.setModel', sessionId: active.sessionId, model }).catch((e) => toast(e.message));
  const setEffort = (effort: EffortLevel) => active && ws.request({ kind: 'session.setEffort', sessionId: active.sessionId, effort }).catch((e) => toast(e.message));

  const totals = useMemo(() => {
    if (!active) return null;
    let inp = 0, out = 0, cache = 0, cost = 0, turns = 0;
    for (const it of active.conv.items) {
      if (it.kind === 'assistant' && it.usage) { inp += it.usage.input; out += it.usage.output; cache += it.usage.cacheRead; }
      if (it.kind === 'result') cost += it.costUsd;
      if (it.kind === 'user' && !it.meta) turns++;
    }
    return { inp, out, cache, cost, turns };
  }, [active?.version]);
  const last = active?.conv.lastResult;
  const runningTasks = active ? [...active.conv.tasks.values()].filter((t) => t.status === 'running').length : 0;
  const recentDirs = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].slice(0, 8), [sessions]);

  return (
    <div className="composer">
      <div className="composer-inner">
        {matches.length > 0 && (
          <div className="palette">
            {matches.map((c, i) => (
              <div key={c.name} className={`it ${i === palIdx ? 'sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickCmd(c.name); }}>
                <span className="n">/{c.name} <span style={{ color: 'var(--fg-3)' }}>{c.argumentHint}</span></span>
                <span className="d">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        {active && active.queue.length > 0 && !welcome && (
          <div className="queue">
            <span className="spinner" /> 已排队 {active.queue.length} 条，当前轮结束后发送
            <button className="btn sm ghost" onClick={() => useStore.setState((s) => ({ open: { ...s.open, [active.sessionId]: { ...active, queue: [] } } }))}>清空</button>
          </div>
        )}
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
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
            placeholder={welcome ? '今天做点什么？' : active?.state === 'history' ? '回复以继续这个会话…' : busy ? '运行中，输入会排队 · Esc 中断' : '回复 Claude… 输入 / 查看命令'}
            onChange={(e) => { setText(e.target.value); if (active && !welcome) setDraft(active.sessionId, e.target.value); }}
            onKeyDown={onKey}
            onPaste={(e) => addFiles(e.clipboardData.files)}
          />
          <div className="composer-bar">
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
            <button className="icon-btn" title="添加图片" onClick={() => fileInput.current?.click()}>＋</button>
            {welcome ? (
              <>
                <button className="dirpick" onClick={pickDir} title={cwd || '选择工作目录'}>
                  <span style={{ color: 'var(--fg-2)' }}>▤</span>
                  <span>{cwd ? basename(cwd) : '选择目录'}</span>
                  {recentDirs.length > 0 && (
                    <select value={cwd} onChange={(e) => setCwd(e.target.value)} onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', opacity: 0, inset: 0, width: '100%', cursor: 'pointer' }}>
                      {recentDirs.map((d) => <option key={d} value={d}>{d}</option>)}
                      {cwd && !recentDirs.includes(cwd) && <option value={cwd}>{cwd}</option>}
                    </select>
                  )}
                </button>
                <button className="btn sm ghost" onClick={pickDir} title="浏览文件夹">…</button>
              </>
            ) : null}
            <span className="grow" />
            {welcome ? (
              <>
                <label className="chip"><span>{MODEL_ALIASES.find((m) => m.value === wModel)?.label ?? wModel}</span><span className="caret">▾</span>
                  <select value={wModel} onChange={(e) => setWModel(e.target.value)}>{MODEL_ALIASES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
                </label>
                <label className="chip"><span>{wEffort || 'effort'}</span><span className="caret">▾</span>
                  <select value={wEffort} onChange={(e) => setWEffort(e.target.value as EffortLevel)}><option value="">默认</option>{['low', 'medium', 'high', 'xhigh', 'max'].map((l) => <option key={l} value={l}>{l}</option>)}</select>
                </label>
                <label className={clsx('chip', wMode === 'bypassPermissions' && 'warn')}><span>{MODE_LABEL[wMode]}</span><span className="caret">▾</span>
                  <select value={wMode} onChange={(e) => setWMode(e.target.value as PermissionMode)}>{(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
                </label>
              </>
            ) : liveOk ? (
              <>
                <label className="chip" title="模型"><span>{info.models?.find((m) => m.value === info.model)?.displayName ?? shortModel(info.model)}</span><span className="caret">▾</span>
                  <select value={info.model ?? ''} onChange={(e) => setModel(e.target.value)}>
                    {(info.models ?? []).map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
                    {info.model && !info.models?.some((m) => m.value === info.model) && <option value={info.model}>{shortModel(info.model)}</option>}
                  </select>
                </label>
                <label className="chip" title="Effort"><span>{info.effort ?? 'effort'}</span><span className="caret">▾</span>
                  <select value={info.effort ?? ''} onChange={(e) => setEffort(e.target.value as EffortLevel)}><option value="" disabled>effort</option>{['low', 'medium', 'high', 'xhigh', 'max'].map((l) => <option key={l} value={l}>{l}</option>)}</select>
                </label>
                <label className={clsx('chip', info.permissionMode === 'bypassPermissions' && 'warn')} title="权限模式"><span>{MODE_LABEL[info.permissionMode ?? 'default']}</span><span className="caret">▾</span>
                  <select value={info.permissionMode ?? 'default'} onChange={(e) => setMode(e.target.value as PermissionMode)}>{(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
                </label>
              </>
            ) : active ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{active.state === 'starting' ? '启动中…' : '未运行 · 发送即恢复'}</span>
            ) : null}
            {busy ? (
              <button className="send stop" title="中断 (Esc)" onClick={() => active && interrupt(active.sessionId)}>■</button>
            ) : (
              <button className="send" disabled={!canSend} onClick={doSend} title="发送 (Enter)">{starting ? <span className="spinner" /> : '↑'}</button>
            )}
          </div>
        </div>
        {!welcome && totals && (
          <div className="statusbar">
            <span>{totals.turns} 轮</span>
            <span>↑{fmtTok(totals.inp + totals.cache)} ↓{fmtTok(totals.out)}</span>
            {totals.cache > 0 && <span>缓存 {Math.round((totals.cache / Math.max(1, totals.inp + totals.cache)) * 100)}%</span>}
            {totals.cost > 0 && <span>{fmtUsd(totals.cost)}</span>}
            {last && <span>上轮 {fmtMs(last.durationMs)}</span>}
            {runningTasks > 0 && <span style={{ color: 'var(--green)' }}>{runningTasks} 个后台任务</span>}
          </div>
        )}
      </div>
    </div>
  );
}
