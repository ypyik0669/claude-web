import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { clsx, fmtTok, fmtUsd, fmtMs, shortModel, basename } from '@/util';
import { parsePeerId, type AgentKind, type AttachmentRef, type EffortLevel, type PermissionMode, type SessionFeatures } from '@shared';
import { compressImage, expandDataTransfer, fmtSize, isLongPaste, pasteAsAttachment, uploadAttachment, type DroppedFile, type PendingImage } from '@/model/attachments';
import { StatusStrip } from '@/features/chat/StatusStrip';
import { RunCard } from '@/features/chat/RunCard';
import { ContextRow } from './ContextRow';
import { attachmentFolderPath } from '@/features/paths';
import { Icon } from '@/ui/icons';
import { CATALOG, effortLevels, modelsFor } from '@catalog';
import { usePaneCtx } from '@/store/paneContext';
import { activeGroup } from '@/model/layout';
import { sessionRefMarker } from '@/model/conversation';
import { SessionRefChip } from '@/features/chat/ChatView';
import { REFERENCE_EVENT, type ReferenceDetail } from '@/features/sidebar/session-actions';
import { ModelChip } from '@/features/models/ModelMenu';
import { chipLabel, compatibleTypes, type ModelMenuItem } from '@/features/models/menu';
import { routePick } from '@/features/models/route';
import { providersLoaded } from '@/features/models/data';
import { dlg } from '@/ui/dialog';

export const MODE_LABEL: Record<PermissionMode, string> = { default: '每次询问', acceptEdits: '自动接受编辑', plan: '计划模式', auto: '自动模式', bypassPermissions: '完全权限', dontAsk: '不询问' };
// sessions on another machine: uploads land on this machine's disk, out of the remote agent's reach
const REMOTE_ATTACH = '附件在本机，远端读不到，请粘贴内容（图片可以直接发）';

/**
 * The composer is used in two places: inside an open session (sends to it) and on the welcome screen
 * (creates a session on first send). `welcome` mode carries its own model/mode/cwd state.
 */
export function Composer({ welcome = false, target, disabled = false }: { welcome?: boolean; target?: { paneId: string; tileId: string }; disabled?: boolean }) {
  const active = useScopedSession();
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const setDraft = useStore((s) => s.setDraft);
  const saveDraft = useStore((s) => s.saveDraft);
  const openSession = useStore((s) => s.openSession);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(welcome ? '' : active?.draft ?? '');
  const [imgs, setImgs] = useState<PendingImage[]>([]);
  const [atts, setAtts] = useState<AttachmentRef[]>([]); // inline text attachments
  const [files, setFiles] = useState<DroppedFile[]>([]); // uploaded on send
  const [refs, setRefs] = useState<{ id: string; title: string }[]>([]); // referenced sessions → <session-ref /> markers on send
  const pane = usePaneCtx();
  const [upload, setUpload] = useState<{ done: number; total: number; name: string } | null>(null);
  const [palIdx, setPalIdx] = useState(0);
  // a session on another machine: uploaded files land on THIS machine's disk, the remote agent can't read
  // their paths — images (sent inline) and pasted text still work
  const remote = !welcome && !!active && !!parsePeerId(active.sessionId);
  // welcome-mode settings
  const [cwd, setCwd] = useState(localStorage.getItem('cw.lastCwd') || sessions[0]?.cwd || '');
  const [wModel, setWModel] = useState(localStorage.getItem('cw.lastModel') || '');
  const [wMode, setWMode] = useState<PermissionMode>((localStorage.getItem('cw.lastMode') as PermissionMode) || 'default');
  const [wEffort, setWEffort] = useState<EffortLevel | ''>('');
  const [wUltra, setWUltra] = useState(false);
  const [starting, setStarting] = useState(false);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const togglePanel = useStore((s) => s.togglePanel);
  const [wProvider, setWProvider] = useState<string>(localStorage.getItem('cw.lastProvider') || (settings.defaultProviderId as string) || 'claude');
  const agents = useStore((s) => s.agents);
  const [wAgent, setWAgent] = useState<AgentKind>((localStorage.getItem('cw.lastAgent') as AgentKind) || 'claude');
  const agent = wAgent !== 'claude' ? agents.find((a) => a.kind === wAgent) : undefined;
  const foreign = !!agent;
  const wKind: AgentKind = foreign ? wAgent : 'claude';
  // a remembered profile the chosen agent cannot use (or one since deleted) falls back to the agent's own login
  const provider = wProvider === 'claude' ? undefined : providers.find((p) => p.id === wProvider && compatibleTypes(wKind).includes(p.type));
  // the agent's own model list: the catalog, or what the agent registry probed when the catalog has none
  const wBuiltin = agent && !modelsFor(agent.kind).length ? agent.models.map((m) => ({ value: m, displayName: m })) : undefined;
  const pickWelcome = (it: ModelMenuItem) => { setWProvider(it.providerId); setWModel(it.model); return true; };
  // the remembered profile is gone (deleted, or unusable by this agent): its model goes with it, or a relay's
  // model id would be sent to the agent's own login
  useEffect(() => {
    if (!welcome || wProvider === 'claude' || provider || !providersLoaded(providers)) return;
    setWProvider('claude');
    setWModel('');
    localStorage.removeItem('cw.lastProvider');
    localStorage.removeItem('cw.lastModel');
  }, [welcome, wProvider, provider, providers]);
  // effort is per agent AND per model: Gemini has none, Codex alone has `ultra`, Opus/Sonnet 4.6 have no `xhigh`
  const wEfforts = effortLevels(wKind, wModel || undefined);
  const wUltracode = !!CATALOG[wKind]?.supportsUltracode;
  const catalogNote = CATALOG[wKind]?.note;
  const [wFeatures, setWFeatures] = useState<SessionFeatures>(() => { try { return JSON.parse(localStorage.getItem('cw.lastFeatures') ?? '{}'); } catch { return {}; } });
  const [featOpen, setFeatOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const speechOk = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const draftKey = welcome ? 'welcome' : active?.sessionId ?? '';

  // welcome draft lives on the server (desktop origin changes with the port)
  useEffect(() => {
    if (!welcome) return;
    void useStore.getState().loadDraft('welcome').then((d) => { if (d) setText((t) => t || d); });
  }, [welcome]);
  // a session draft may arrive after mount (loadHistory → loadDraft)
  useEffect(() => {
    if (!welcome && active?.draft && !text) setText(active.draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.draft]);

  const toggleVoice = () => {
    if (listening) { recRef.current?.stop(); return; }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = navigator.language.startsWith('zh') ? 'zh-CN' : navigator.language;
    rec.interimResults = true;
    rec.continuous = true;
    let base = text;
    rec.onresult = (ev: any) => {
      let finalT = '', interim = '';
      for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finalT += r[0].transcript; else interim += r[0].transcript; }
      setText(base + finalT + interim);
    };
    rec.onend = () => { setListening(false); recRef.current = null; };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    rec.start();
  };
  useEffect(() => () => { recRef.current?.stop?.(); }, []);
  const featCount = Object.entries(wFeatures).filter(([k, v]) => k !== 'env' && (Array.isArray(v) ? v.length : !!v)).length;

  useEffect(() => {
    if (!cwd && sessions[0]?.cwd) setCwd(sessions[0].cwd);
  }, [sessions]);

  const autosize = () => {
    const el = ta.current;
    if (!el || !el.clientWidth) return; // hidden / not laid out yet: a bogus scrollHeight would stick
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  };
  useEffect(autosize, [text]);
  // pane resizes / tab switches change the wrap width → re-measure
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const ro = new ResizeObserver(() => autosize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const canSend = (text.trim().length > 0 || imgs.length > 0 || atts.length > 0 || files.length > 0 || refs.length > 0) && !starting && !upload && !disabled;

  // "引用到输入框" from a session menu: only the composer of the focused pane's front tile takes it
  useEffect(() => {
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<ReferenceDetail>).detail;
      if (d.handled || !pane || disabled) return;
      const g = activeGroup(useStore.getState().layout);
      const p = g.panes[pane.paneId];
      if (g.focusedPaneId !== pane.paneId || !p || (p.activeTileId ?? p.tiles[0]?.id) !== pane.tileId) return;
      if (!welcome && active?.sessionId === d.id) { d.reason = '不能引用会话自己'; return; }
      d.handled = true;
      setRefs((r) => (r.some((x) => x.id === d.id) ? r : [...r, { id: d.id, title: d.title }]));
      ta.current?.focus();
    };
    window.addEventListener(REFERENCE_EVENT, on);
    return () => window.removeEventListener(REFERENCE_EVENT, on);
  }, [pane?.paneId, pane?.tileId, active?.sessionId, welcome, disabled]);
  /** the typed text plus one marker per referenced session (the server expands them into briefings) */
  const withRefs = (t: string) => (refs.length ? `${t}${t ? '\n\n' : ''}${refs.map((r) => sessionRefMarker(r.id, r.title)).join('\n')}` : t);

  const onChange = (v: string) => {
    setText(v);
    if (active && !welcome) setDraft(active.sessionId, v);
    if (draftKey) saveDraft(draftKey, v);
  };

  /** Upload dropped files for `sessionId` and return attachment refs. */
  const uploadAll = async (sessionId: string): Promise<AttachmentRef[]> => {
    const out: AttachmentRef[] = [];
    const folders = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setUpload({ done: i, total: files.length, name: f.rel });
      const r = await uploadAttachment(sessionId, f.file, f.rel);
      const top = f.rel.includes('/') ? f.rel.split('/')[0] : null;
      if (top) {
        if (!folders.has(top)) { folders.add(top); out.push({ kind: 'folder', name: top, path: attachmentFolderPath(r.path, f.rel, top), size: undefined }); }
      } else out.push({ kind: f.file.type.startsWith('image/') ? 'image' : 'file', name: f.file.name, path: r.path, size: r.size });
    }
    setUpload(null);
    return out;
  };

  const doSend = async () => {
    if (!canSend) return;
    const t = text;
    if (/^\/goal\s+\S/.test(t.trim())) {
      const objective = t.trim().replace(/^\/goal\s+/, '');
      const cwdFor = welcome ? cwd.trim() : active?.cwd ?? '';
      if (!cwdFor) { toast('先选一个目录'); return; }
      try {
        const g = await ws.request<{ id: string }>({ kind: 'goals.create', objective, cwd: cwdFor, permissionMode: welcome ? wMode : (active?.info?.permissionMode ?? 'acceptEdits'), agent: welcome ? (foreign ? wAgent : undefined) : (active?.info?.agent && active.info.agent !== 'claude' ? active.info.agent : undefined) });
        await ws.request({ kind: 'goals.start', id: g.id });
        onChange(''); // also clears the persisted draft, or the /goal line comes back on reopen
        if (!useStore.getState().panels.includes('goals')) togglePanel('goals');
        toast('目标已创建并启动，进度看「目标」面板', true);
      } catch (e: any) { toast(e.message); }
      return;
    }
    const im = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
    if (welcome) {
      if (!cwd.trim()) return toast('请先选择工作目录');
      setStarting(true);
      try {
        localStorage.setItem('cw.lastCwd', cwd);
        localStorage.setItem('cw.lastModel', wModel);
        localStorage.setItem('cw.lastMode', wMode);
        localStorage.setItem('cw.lastProvider', wProvider);
        localStorage.setItem('cw.lastAgent', wAgent);
        if (wAgent !== 'claude' && !agent) throw new Error('选中的 agent 已不可用');
        localStorage.setItem('cw.lastFeatures', JSON.stringify(wFeatures));
        const id = await openSession({ cwd: cwd.trim(), model: wModel || undefined, permissionMode: wMode, effort: wEffort || undefined, ultracode: wUltra || undefined, providerId: provider ? provider.id : 'claude', features: foreign ? {} : wFeatures, agent: foreign ? wAgent : undefined }, target);
        const uploaded = files.length ? await uploadAll(id) : [];
        await send(id, withRefs(t), im, false, [...atts, ...uploaded]);
        setRefs([]);
        saveDraft('welcome', '');
      } catch (e: any) {
        toast(e.message);
      }
      setStarting(false);
      setUpload(null);
      return;
    }
    if (!active) return;
    setText('');
    setImgs([]);
    setAtts([]);
    setRefs([]);
    setDraft(active.sessionId, '');
    const sentImgs = imgs, sentAtts = atts, sentRefs = refs;
    const full = withRefs(t);
    let uploaded: AttachmentRef[];
    try {
      uploaded = files.length ? await uploadAll(active.sessionId) : [];
    } catch (e: any) {
      // nothing was sent: put the message back instead of silently dropping what the user typed
      toast(e.message);
      setUpload(null);
      setText((cur) => cur || t);
      if (t) setDraft(active.sessionId, t);
      setImgs((cur) => (cur.length ? cur : sentImgs));
      setAtts((cur) => (cur.length ? cur : sentAtts));
      setRefs((cur) => (cur.length ? cur : sentRefs));
      return;
    }
    try {
      setFiles([]);
      await send(active.sessionId, full, im, false, [...atts, ...uploaded]);
    } catch (e: any) {
      toast(e.message);
      setUpload(null);
    }
  };

  const pickCmd = (name: string) => {
    setText(`/${name} `);
    ta.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && slashQuery !== null && !e.nativeEvent.isComposing) {
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

  const addImages = async (list: Iterable<File | Blob>, names?: string[]) => {
    let i = 0;
    for (const f of list) {
      if (!f.type.startsWith('image/')) { i++; continue; }
      const img = await compressImage(f, names?.[i] ?? (f as File).name);
      setImgs((s) => [...s, img]);
      i++;
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (disabled) return;
    const imgFiles = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (imgFiles.length) { e.preventDefault(); void addImages(imgFiles); return; }
    const t = e.clipboardData.getData('text/plain');
    if (t && isLongPaste(t)) {
      e.preventDefault();
      setAtts((s) => [...s, pasteAsAttachment(t)]);
      toast(`长文本已作为附件（${t.length} 字符）`, true);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    const { files: dropped, folders, truncated } = await expandDataTransfer(e.dataTransfer);
    const imgOnly = dropped.filter((d) => !d.rel.includes('/') && d.file.type.startsWith('image/'));
    const rest = dropped.filter((d) => !imgOnly.includes(d));
    if (imgOnly.length) void addImages(imgOnly.map((d) => d.file), imgOnly.map((d) => d.file.name));
    if (rest.length && remote) { toast(REMOTE_ATTACH); return; }
    if (rest.length) setFiles((s) => [...s, ...rest].slice(0, 500));
    if (folders.length) toast(`已附加文件夹 ${folders.join(', ')}（${rest.length} 个文件${truncated ? '，已截断到 500' : ''}）`, true);
  };
  const fileInput = useRef<HTMLInputElement>(null);

  const pickDir = async () => {
    const p = desktop ? await desktop.pickDir() : await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) setCwd(p);
  };

  // live controls
  const info = active?.info;
  const liveOk = !welcome && active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error' && info;
  // the model's own capability flags decide the ladder; fall back to the catalog for agents that don't report
  const liveModel = info?.models?.find((m) => m.value === info?.model);
  const liveEfforts: EffortLevel[] = liveModel?.supportedEffortLevels?.length
    ? liveModel.supportedEffortLevels
    : liveModel?.supportsEffort === false ? [] : effortLevels(info?.agent ?? 'claude', info?.model ?? undefined);
  const setMode = (mode: PermissionMode) => active && ws.request({ kind: 'session.setPermissionMode', sessionId: active.sessionId, mode }).catch((e) => toast(e.message));
  const setModel = (model: string) => active && ws.request({ kind: 'session.setModel', sessionId: active.sessionId, model }).catch((e) => toast(e.message));
  // the unified model menu inside a session: same profile → setModel; another profile → the invisible
  // restart of session.setProvider, started directly on the picked model
  const [swapping, setSwapping] = useState(false);
  const liveAgent: AgentKind = info?.agent ?? 'claude';
  const liveProvider = info?.providerId && info.providerId !== 'claude' ? info.providerId : 'claude';
  const liveAgentDefault = liveAgent !== 'claude' ? agents.find((a) => a.kind === liveAgent)?.model || undefined : undefined;
  /** false = nothing happened (refused / cancelled / failed): the menu then does not record it as recent */
  const pickLive = async (it: ModelMenuItem): Promise<boolean> => {
    if (!active || swapping) return false;
    const act = routePick(it, { agent: liveAgent, currentProvider: remote ? 'claude' : liveProvider, currentModel: info?.model, remote, busy, providers, agentDefault: liveAgentDefault });
    if (act.kind === 'none') return true;
    if (act.kind === 'error') { toast(act.message); return false; }
    if (act.kind === 'setModel') {
      try { await ws.request({ kind: 'session.setModel', sessionId: active.sessionId, model: act.model }); return true; } catch (e: any) { toast(e.message); return false; }
    }
    if (act.confirm && !(await dlg.confirm('切换供应商档案？', { message: '会话正在运行。换档案会重启会话进程（历史保留），当前这一轮会被中断。', okLabel: '切换' }))) return false;
    setSwapping(true);
    try {
      await ws.request({ kind: 'session.setProvider', sessionId: active.sessionId, providerId: act.providerId, model: act.model });
      toast(`已切换到 ${it.label}，会话继续`, true);
      return true;
    } catch (e: any) { toast(e.message); return false; } finally { setSwapping(false); }
  };
  const setEffort = (effort: EffortLevel) => active && ws.request({ kind: 'session.setEffort', sessionId: active.sessionId, effort }).catch((e) => toast(e.message));
  const setUltracode = (on: boolean) => active && ws.request({ kind: 'session.setUltracode', sessionId: active.sessionId, on }).catch((e) => toast(e.message));

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
  const cu = active?.contextUsage ?? active?.conv.contextUsage;
  const folderChips = useMemo(() => { const m = new Map<string, number>(); for (const f of files) { const top = f.rel.includes('/') ? f.rel.split('/')[0] : null; if (top) m.set(top, (m.get(top) ?? 0) + 1); } return m; }, [files]);

  return (
    <div className="composer">
      <div className="composer-inner">
        {matches.length > 0 && (
          <div className="palette">
            {matches.map((c, i) => (
              <div key={c.name} className={`it ${i === palIdx ? 'sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickCmd(c.name); }}>
                <span className="n">/{c.name} <span style={{ color: 'var(--ink-4)' }}>{c.argumentHint}</span></span>
                <span className="d">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        {active && !welcome && <StatusStrip sessionId={active.sessionId} onRecall={(t) => { setText((cur) => (cur ? `${cur}\n${t}` : t)); ta.current?.focus(); }} />}
        {active && !welcome && <RunCard sessionId={active.sessionId} />}
        {active && !welcome && active.cwd && <ContextRow cwd={active.cwd} info={info} sessionId={active.sessionId} />}
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {(imgs.length > 0 || atts.length > 0 || files.length > 0 || refs.length > 0 || upload) && (
            <div className="attach">
              {refs.map((r) => (
                <SessionRefChip key={`r${r.id}`} a={{ kind: 'session', name: r.title, sessionId: r.id }} onRemove={() => setRefs((s) => s.filter((x) => x.id !== r.id))} />
              ))}
              {imgs.map((im, i) => (
                <img key={i} src={im.url} alt="" onClick={() => setImgs((s) => s.filter((_, j) => j !== i))} title={`${im.name ?? '图片'} · 点击移除`} />
              ))}
              {atts.map((a, i) => (
                <span key={`a${i}`} className="att-chip" title={a.text?.slice(0, 300)}><Icon name="read" size={12} /> {a.name} <span className="sz">{fmtSize(a.size)}</span><button aria-label="移除" onClick={() => setAtts((s) => s.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button></span>
              ))}
              {[...folderChips].map(([name, n]) => (
                <span key={`d${name}`} className="att-chip" title={`${n} 个文件`}><Icon name="folder" size={12} /> {name} <span className="sz">{n} 文件</span><button aria-label="移除" onClick={() => setFiles((s) => s.filter((f) => !f.rel.startsWith(name + '/')))}><Icon name="close" size={10} /></button></span>
              ))}
              {files.filter((f) => !f.rel.includes('/')).map((f, i) => (
                <span key={`f${i}`} className="att-chip" title={f.file.name}><Icon name="attach" size={12} /> {f.file.name} <span className="sz">{fmtSize(f.file.size)}</span><button aria-label="移除" onClick={() => setFiles((s) => s.filter((x) => x !== f))}><Icon name="close" size={10} /></button></span>
              ))}
              {upload && <span className="att-chip"><span className="spinner" /> 上传 {upload.done + 1}/{upload.total} · {upload.name}</span>}
            </div>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={disabled ? '会话已被删除，不能继续' : welcome ? '今天做点什么？（可拖入文件或文件夹）' : active?.state === 'history' ? '回复以继续这个会话…' : busy ? '运行中，输入会排队 · Esc 中断' : `回复 ${info?.agentName && info.agent !== 'claude' ? info.agentName : 'Claude'}… 输入 / 查看命令，拖入文件作为附件`}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          <div className="composer-bar">
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const fl = Array.from(e.target.files ?? []); void addImages(fl.filter((f) => f.type.startsWith('image/'))); if (remote && fl.some((f) => !f.type.startsWith('image/'))) { toast(REMOTE_ATTACH); e.target.value = ''; return; } setFiles((s) => [...s, ...fl.filter((f) => !f.type.startsWith('image/')).map((f) => ({ file: f, rel: f.name }))]); e.target.value = ''; }} />
            <button className="icon-btn" title="添加图片 / 文件" aria-label="添加附件" disabled={disabled} onClick={() => fileInput.current?.click()}><Icon name="plus" size={16} /></button>
            {welcome ? (
              <>
                <button className="dirpick" onClick={pickDir} title={cwd || '选择工作目录'}>
                  <span style={{ color: 'var(--ink-4)', display: 'inline-flex' }}><Icon name="folder" size={13} /></span>
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
            {speechOk && (
              <button className={clsx('icon-btn', listening && 'active')} title={listening ? '停止语音输入' : '语音输入（浏览器识别）'} onClick={toggleVoice} aria-label="语音输入"><Icon name="mic" size={15} /></button>
            )}
            {welcome ? (
              <>
                <label className={clsx('chip', foreign && 'info')} title="agent：Claude Code 或其它 CLI agent（Codex、Gemini、Qwen、Kimi、ACP）；供应商档案在模型菜单里选"><span>{agent ? agent.name : 'Claude Code'}</span><span className="caret"><Icon name="chevronDown" size={10} /></span>
                  <select value={foreign ? `agent:${wAgent}` : 'claude'} onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__add') { useStore.setState({ configTab: 'providers' }); if (!useStore.getState().panels.includes('config')) togglePanel('config'); return; }
                    if (v === '__agents') { useStore.getState().openSettings({ section: 'agents' }); return; }
                    const kind = (v.startsWith('agent:') ? v.slice(6) : 'claude') as AgentKind;
                    setWAgent(kind);
                    // keep the profile when the new agent can use it; the model list differs per agent, so reset the model
                    const cur = providers.find((p) => p.id === wProvider);
                    if (!cur || !compatibleTypes(kind).includes(cur.type)) setWProvider('claude');
                    setWModel('');
                  }}>
                    <option value="claude">Claude Code</option>
                    <optgroup label="其它 agent">
                      {agents.filter((a) => a.kind !== 'claude' && a.enabled).map((a) => <option key={a.kind} value={`agent:${a.kind}`} disabled={!a.installed}>{a.name}{a.installed ? (a.label ? ` · ${a.label}` : '') : '（未安装）'}</option>)}
                      <option value="__agents">管理 agent…</option>
                    </optgroup>
                    <option value="__add">+ 添加供应商档案…</option>
                  </select>
                </label>
                {!foreign && <span style={{ position: 'relative' }}>
                  <button className={clsx('chip', featCount > 0 && 'warn')} onClick={() => setFeatOpen(!featOpen)} title="会话附加功能（Chrome / Computer Use / 协调者 / 主动模式 / 频道）">功能{featCount ? ` ${featCount}` : ''} <span className="caret"><Icon name="chevronDown" size={10} /></span></button>
                  {featOpen && (
                    <div className="menu" style={{ bottom: '100%', right: 0, marginBottom: 6, minWidth: 260, padding: 8 }} onMouseLeave={() => setFeatOpen(false)}>
                      {([
                        ['chrome', 'Claude in Chrome（浏览器自动化）'],
                        ['computerUse', 'Computer Use（截图 / 键鼠）'],
                        ['coordinator', '协调者模式（只派活给子代理）'],
                        ['proactive', '主动模式（空闲时继续干活）'],
                        ['brief', 'Brief（SendUserMessage 工具）'],
                      ] as [keyof SessionFeatures, string][]).map(([k, l]) => (
                        <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 4px', fontSize: 12.5, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!wFeatures[k]} onChange={(e) => setWFeatures({ ...wFeatures, [k]: e.target.checked })} />
                          <span style={{ flex: 1 }}>{l}</span>
                        </label>
                      ))}
                      <div style={{ padding: '4px 4px', fontSize: 12 }}>
                        频道
                        <input className="field" style={{ width: '100%', marginTop: 4 }} placeholder="plugin:name@marketplace, server:name" value={(wFeatures.channels ?? []).join(', ')} onChange={(e) => setWFeatures({ ...wFeatures, channels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                      </div>
                    </div>
                  )}
                </span>}
                <ModelChip
                  agent={wKind}
                  current={{ providerId: provider ? provider.id : 'claude', model: wModel }}
                  label={chipLabel({ agent: wKind, providers, providerId: provider?.id, model: wModel, builtin: wBuiltin, agentDefault: agent?.model || undefined })}
                  title="供应商档案 / 模型：一次选中两者"
                  builtin={wBuiltin}
                  builtinTitle={agent ? `${agent.name} 账号` : 'Claude 账号'}
                  agentDefault={agent?.model || undefined}
                  onPick={pickWelcome}
                />
                {wEfforts.length > 0 && <label className="chip" title={catalogNote ?? 'effort'}><span>{wEffort || 'effort'}</span><span className="caret"><Icon name="chevronDown" size={10} /></span>
                  <select value={wEffort} onChange={(e) => setWEffort(e.target.value as EffortLevel)}><option value="">默认{CATALOG[wKind]?.defaultEffort ? `（${CATALOG[wKind]!.defaultEffort}）` : ''}</option>{wEfforts.map((l) => <option key={l} value={l}>{l}</option>)}</select>
                </label>}
                {wUltracode && <button type="button" className={clsx('chip', wUltra && 'active')} title="ultracode：xhigh + 动态工作流编排（会话级，不是一个 effort 等级）" onClick={() => setWUltra(!wUltra)}><Icon name="bolt" size={12} /> ultracode</button>}
                <label className={clsx('chip', wMode === 'bypassPermissions' && 'warn')}><span>{MODE_LABEL[wMode]}</span><span className="caret"><Icon name="chevronDown" size={10} /></span>
                  <select value={wMode} onChange={(e) => setWMode(e.target.value as PermissionMode)}>{(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
                </label>
              </>
            ) : liveOk ? (
              <>
                <ModelChip
                  agent={liveAgent}
                  current={{ providerId: remote ? 'claude' : liveProvider, model: info.model }}
                  label={remote
                    ? `${info.providerName ? `${info.providerName} / ` : ''}${info.models?.find((m) => m.value === info.model)?.displayName ?? (shortModel(info.model) || '模型')}`
                    : chipLabel({ agent: liveAgent, providers, providerId: liveProvider, providerName: info.providerName, model: info.model, builtin: liveProvider === 'claude' && info.models?.length ? info.models : undefined, agentDefault: liveAgentDefault })}
                  title={remote ? '模型（其它机器上的会话：换档案请在那台机器上操作）' : '供应商档案 / 模型：同一档案直接换模型，换档案会无感重启会话'}
                  builtin={(remote || liveProvider === 'claude') && info.models?.length ? info.models : undefined}
                  builtinTitle={remote ? info.providerName ?? info.agentName ?? '模型' : liveAgent === 'claude' ? 'Claude 账号' : `${info.agentName ?? liveAgent} 账号`}
                  agentDefault={liveAgentDefault}
                  lockProvider={remote ? 'claude' : undefined}
                  lockNote="其它机器上的会话：只能换模型，换档案请在那台机器上操作"
                  busy={swapping}
                  disabled={swapping}
                  onPick={pickLive}
                />
{liveEfforts.length > 0 && <label className="chip" title="Effort"><span>{info.effort ?? 'effort'}</span><span className="caret"><Icon name="chevronDown" size={10} /></span>
                  <select value={info.effort ?? ''} onChange={(e) => setEffort(e.target.value as EffortLevel)}><option value="" disabled>effort</option>{liveEfforts.map((l) => <option key={l} value={l}>{l}</option>)}</select>
                </label>}
                {info.supportsUltracode !== false && CATALOG[info.agent ?? 'claude']?.supportsUltracode && (
                  <button type="button" className={clsx('chip', info.ultracode && 'active')} title="ultracode：xhigh + 动态工作流编排（会话级，不是一个 effort 等级）" onClick={() => setUltracode(!info.ultracode)}><Icon name="bolt" size={12} /> ultracode</button>
                )}
                <label className={clsx('chip', info.permissionMode === 'bypassPermissions' && 'warn')} title="权限模式"><span>{MODE_LABEL[info.permissionMode ?? 'default']}</span><span className="caret"><Icon name="chevronDown" size={10} /></span>
                  <select value={info.permissionMode ?? 'default'} onChange={(e) => setMode(e.target.value as PermissionMode)}>{(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
                </label>
              </>
            ) : active ? (
              <span style={{ fontSize: 12, color: 'var(--ink-4)' }}>{disabled ? '会话已删除' : active.state === 'starting' ? '启动中…' : '未运行 · 发送即恢复'}</span>
            ) : null}
            {busy && canSend && active && (
              <button className="steer" title="不等这轮结束，立刻插话给 Claude" onClick={async () => { const t = text; setText(''); setDraft(active.sessionId, ''); await send(active.sessionId, t, undefined, true).catch((e) => toast(e.message)); }}>插话 <Icon name="send" size={12} /></button>
            )}
            {busy ? (
              <button className="send stop" title="中断 (Esc)" onClick={() => active && interrupt(active.sessionId)} aria-label="中断"><Icon name="stop" size={13} /></button>
            ) : (
              <button className="send" disabled={!canSend} onClick={doSend} title="发送 (Enter)" aria-label="发送">{starting || upload ? <span className="spinner" /> : <Icon name="send" size={16} />}</button>
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
            {cu && <span title={`${fmtTok(cu.totalTokens)} / ${fmtTok(cu.maxTokens)} · ${cu.model ?? ''}`} style={{ color: cu.percentage >= 80 ? 'var(--yellow)' : undefined }}>上下文 {cu.percentage}%</span>}
            {runningTasks > 0 && <span style={{ color: 'var(--green)' }}>{runningTasks} 个后台任务</span>}
          </div>
        )}
      </div>
    </div>
  );
}
