import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { clsx, shortModel } from '@/util';
import { parsePeerId, type AgentKind, type AttachmentRef, type EffortLevel, type PermissionMode, type SessionFeatures } from '@shared';
import { compressImage, expandDataTransfer, fmtSize, isLongPaste, pasteAsAttachment, uploadAttachment, type DroppedFile, type PendingImage } from '@/model/attachments';
import { pickFolderFiles } from '@/model/attachment-filter';
import { StatusStrip } from '@/features/chat/StatusStrip';
import { RunCard } from '@/features/chat/RunCard';
import { PermissionDock, runDockPrimary } from '@/features/chat/PermissionCards';
import { denyResponse, dockAction, dockDecide, dockKind, isSlashCommand, primaryKey, type DockSeen, type DockWhy } from '@/features/chat/permission-dock';
import { attachmentFolderPath } from '@/features/paths';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { CATALOG, effortLevels, modelsFor } from '@catalog';
import { usePaneCtx } from '@/store/paneContext';
import { activeGroup } from '@/model/layout';
import { sessionRefMarker } from '@/model/conversation';
import { SessionRefChip } from '@/features/chat/ChatView';
import { REFERENCE_EVENT, handOver, type ReferenceDetail } from '@/features/sidebar/session-actions';
import { ModelChip } from '@/features/models/ModelMenu';
import { OWN_PROVIDER, effectiveRuntime, usableProfile, type AgentSource, type ModelMenuItem } from '@/features/models/menu';
import { resumeView } from '@/store/reopen';
import { routePick, switchedNote } from '@/features/models/route';
import { claudeEffortView, modelChipText } from '@/features/models/intelligence';
import { useAccountDefault } from '@/features/models/account-default';
import { providersLoaded, useGatewayStatus } from '@/features/models/data';
import { needsModel, welcomeProvider } from './welcome-provider';
import { connectModel, useConnect } from '@/features/providers/ConnectModel';
import { dlg, useDialogStore } from '@/ui/dialog';
import { DOCK_BLOCKED, DOCK_CARRIED, DOCK_ENTER_IGNORED, DOCK_PLACEHOLDER, DOCK_REQUEUED, DOCK_SEND, TERMS } from '@/ui/terms';
import { showGoals } from '@/features/workbench/right-panel';
import { ComposerBar } from './ComposerBar';
import { PlusMenu } from './PlusMenu';
import { PermissionChip } from './PermissionChip';
import { BranchChip, ProjectChip } from './ProjectChip';
import { ContextMeter } from './ContextMeter';
import { BAR_ID } from './ids';
import { FEATURE_DEFAULTS_KEY, LEGACY_FEATURES_KEY, capabilityTags, migrateFeatureDefaults, withoutTag } from './capabilities';
import { FILL_EVENT, type FillDetail } from './fill';
import { applyStarter, initialCwd } from '@/features/home/model';
import { useAutomation } from '@/features/automation/state';
import { composerCovered } from './covered';

// sessions on another machine: uploads land on this machine's disk, out of the remote agent's reach
const REMOTE_ATTACH = '附件在本机，远端读不到，请粘贴内容（图片可以直接发）';
// goals run on THIS machine (GoalService drives a local runner): it cannot drive a conversation over there
const REMOTE_GOAL = '其它机器上的对话不能在这里设定目标（目标由本机驱动）。可以到那台机器上设定，或先「交给本机的 Agent 继续」';
const NO_FEATURES: SessionFeatures = {};
const isFeatures = (v: unknown): v is SessionFeatures => !!v && typeof v === 'object' && !Array.isArray(v);

/** The agent's name in a docked card's words: 「告诉 Claude 换个做法」, 「告诉 Codex …」. */
function agentWord(info: { agent?: string; agentName?: string } | undefined): string {
  return info?.agent && info.agent !== 'claude' ? info.agentName ?? info.agent : 'Claude';
}

/**
 * Once per page, after meta.json arrived: older builds kept the capability defaults in localStorage
 * (`cw.lastFeatures`), which the desktop app loses on every start (its origin changes with the port). Take them
 * over into `ui.featureDefaults` unless meta.json already has a value, then drop the key.
 */
let featuresMigrated = false;
function migrateFeaturesOnce(): void {
  if (featuresMigrated) return;
  featuresMigrated = true;
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(LEGACY_FEATURES_KEY); } catch { return; }
  const st = useStore.getState();
  const r = migrateFeatureDefaults(st.settings[FEATURE_DEFAULTS_KEY], legacy);
  const drop = () => { try { localStorage.removeItem(LEGACY_FEATURES_KEY); } catch { /* storage blocked */ } };
  if (r.write) void st.setSetting(FEATURE_DEFAULTS_KEY, r.value).then(drop, () => { featuresMigrated = false; });
  else if (r.dropLegacy) drop();
}

/**
 * The composer is used in two places: inside an open session (sends to it) and on the welcome screen
 * (creates a session on first send). `welcome` mode carries its own agent / profile / model / effort / mode /
 * cwd state. Layout (spec §5.4): text box, then one row — `+` · project · branch | model · permission · mic · send
 * (ComposerBar). Everything the old row of chips did is still here: attachments, references and the session
 * capabilities in `+` (PlusMenu), the agent, profile, model, effort and 深度编排 in the model menu, the permission
 * modes in PermissionChip, the stats bar behind the context ring (ContextMeter).
 */
export function Composer({ welcome = false, target, disabled = false, visible = true }: { welcome?: boolean; target?: { paneId: string; tileId: string }; disabled?: boolean; visible?: boolean }) {
  const active = useScopedSession();
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const setDraft = useStore((s) => s.setDraft);
  const setResume = useStore((s) => s.setResume);
  const saveDraft = useStore((s) => s.saveDraft);
  const openSession = useStore((s) => s.openSession);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const mobile = useStore((s) => s.mobile);
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
  // welcome-mode settings: the project the last conversation was started in (spec §5.8), see `initialCwd`
  const workspaces = useStore((s) => s.workspaces);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const [cwd, setCwd] = useState(() => initialCwd({ stored: localStorage.getItem('cw.lastCwd'), sessions, workspaces, meta: sessionMeta }));
  const [wModel, setWModel] = useState(localStorage.getItem('cw.lastModel') || '');
  const settings = useStore((s) => s.settings);
  // an explicit 「新对话默认权限」 (settings, or 「设为新对话的默认…」 in the permission menu) wins over the last one used
  const defaultMode = settings['ui.defaultMode'] as PermissionMode | undefined;
  const [wMode, setWMode] = useState<PermissionMode>(() => defaultMode || (localStorage.getItem('cw.lastMode') as PermissionMode) || 'default');
  const modeTouched = useRef(false);
  useEffect(() => { if (welcome && defaultMode && !modeTouched.current) setWMode(defaultMode); }, [welcome, defaultMode]);
  const [wEffort, setWEffort] = useState<EffortLevel | ''>('');
  const [wUltra, setWUltra] = useState(false);
  const [wWorktree, setWWorktree] = useState('');
  const [starting, setStarting] = useState(false);
  const providers = useStore((s) => s.providers);
  const lastProvider = useRef(localStorage.getItem('cw.lastProvider'));
  const [wProvider, setWProvider] = useState<string>(lastProvider.current || (settings.defaultProviderId as string) || 'claude');
  // picked in the model menu (or connected on send): from then on the choice is the user's, not welcomeProvider's
  const providerPicked = useRef(false);
  const loggedIn = useStore((s) => s.auth?.loggedIn);
  const agents = useStore((s) => s.agents);
  const [wAgent, setWAgent] = useState<AgentKind>((localStorage.getItem('cw.lastAgent') as AgentKind) || 'claude');
  const agent = wAgent !== 'claude' ? agents.find((a) => a.kind === wAgent) : undefined;
  const foreign = !!agent;
  const wKind: AgentKind = foreign ? wAgent : 'claude';
  // a remembered profile the chosen agent cannot use (or one since deleted) falls back to the agent's own login
  const engine = useStore((s) => s.engine);
  const gatewayView = useGatewayStatus();
  // unusable right now (official engine, gateway off / group gone) counts as gone too
  const provider = usableProfile(providers, wProvider, { agent: wKind, engine, gatewayGroups: gatewayView.groups, gatewayEnabled: gatewayView.enabled });
  // the agent's own model list: the catalog, or what the agent registry probed when the catalog has none
  const wBuiltin = agent && !modelsFor(agent.kind).length ? agent.models.map((m) => ({ value: m, displayName: m })) : undefined;
  // providers a Claude conversation could use right now (the model menu's own check)
  const usableIds = useMemo(() => providers.filter((p) => usableProfile(providers, p.id, { agent: 'claude', engine, gatewayGroups: gatewayView.groups, gatewayEnabled: gatewayView.enabled })).map((p) => p.id), [providers, engine, gatewayView.groups, gatewayView.enabled]);
  const usableKey = usableIds.join(',');
  // nothing picked yet: follow welcomeProvider — the settings, the login check and the list arrive after the first
  // render, and a provider connected on first run (or 设为默认 in settings) has to be in the chip without a reload;
  // a logged-out account is never the default when there is a provider. Picked: kept, unless it became unusable
  // (deleted, or not for this agent) — then its model goes with it, or a relay's model id would be sent to the
  // agent's own login
  useEffect(() => {
    if (!welcome || !providersLoaded(providers)) return;
    const keep = wProvider === 'claude' || !!provider;
    const want = foreign ? (keep ? wProvider : 'claude')
      : providerPicked.current && keep ? wProvider
      : welcomeProvider({ last: providerPicked.current ? null : lastProvider.current, def: settings.defaultProviderId as string | undefined, loggedIn, usable: usableIds });
    if (want === wProvider) return;
    setWProvider(want);
    setWModel('');
    if (want === 'claude') { localStorage.removeItem('cw.lastProvider'); localStorage.removeItem('cw.lastModel'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcome, foreign, wProvider, provider, providers, usableKey, settings.defaultProviderId, loggedIn]);
  // effort is per agent AND per model (Codex alone has `ultra`, Opus/Sonnet 4.6 have no `xhigh`); Claude on a provider,
  // on our engine: every model, native or through the prompt (claudeEffortView)
  const wView = claudeEffortView({ agent: wKind, providers, providerId: wProvider, model: wModel, runtime: provider ? effectiveRuntime(provider, engine) : undefined });
  const wEfforts = wView.levels;
  // a level picked for another model that this one lacks falls back to the default (not sent, not shown)
  const wEffortOk = wEffort && wEfforts.includes(wEffort) ? wEffort : undefined;
  const wUltracode = wView.ultracode;
  // the capabilities (+ menu): one set of defaults for new conversations in meta.json, so every composer on screen
  // (and the next start of the desktop app) sees the same
  const storedFeatures = settings[FEATURE_DEFAULTS_KEY];
  const featDefaults: SessionFeatures = isFeatures(storedFeatures) ? storedFeatures : NO_FEATURES;
  const metaLoaded = useStore((s) => s.metaLoaded);
  useEffect(() => { if (metaLoaded) migrateFeaturesOnce(); }, [metaLoaded]);
  const setFeatures = (f: SessionFeatures) => { void useStore.getState().setSetting(FEATURE_DEFAULTS_KEY, f).catch((e) => toast(e.message)); };
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const speechOk = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const draftKey = welcome ? 'welcome' : active?.sessionId ?? '';

  // welcome draft lives on the server (desktop origin changes with the port)
  useEffect(() => {
    if (!welcome) return;
    void useStore.getState().loadDraft('welcome').then((d) => { if (d) setText((t) => t || d); });
  }, [welcome]);
  // a session draft may arrive after mount (loadHistory → loadDraft); under a docked card those are words from
  // before it (the user's next message), not an answer to it (review M-9)
  useEffect(() => {
    if (!welcome && active?.draft && !text) {
      setText(active.draft);
      if (seenRef.current && active.draft.trim()) setSeen({ carried: true });
    }
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

  // the list / the projects arrive after the first paint (and the desktop app forgets localStorage every start)
  useEffect(() => {
    if (!cwd) { const c = initialCwd({ stored: null, sessions, workspaces, meta: sessionMeta }); if (c) setCwd(c); }
  }, [sessions, workspaces, sessionMeta]);

  // a starter / the 入门清单 fills this (welcome) composer: text, project, focus (fill.ts)
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (!welcome || !target) return;
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<FillDetail>).detail;
      if (d.tileId && d.tileId !== target.tileId) return;
      if (d.cwd) setCwd(d.cwd);
      if (d.text !== undefined) onChange(applyStarter(textRef.current, d.text));
      if (d.text !== undefined || d.focus) requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener(FILL_EVENT, on);
    return () => window.removeEventListener(FILL_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcome, target?.tileId]);

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
    // autosize() changes the observed box itself: run it a frame later, or the browser reports
    // "ResizeObserver loop completed with undelivered notifications" as a console error
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(autosize); });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
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
  // a permission / question / plan card docked above the box (redesign phase 5): words typed here are its 拒绝理由 /
  // 修改意见 — sending them denies with them (the old card's reason field, same response); an empty Enter presses the
  // card's main button (允许一次 ↵). What exactly Enter does is `dockAction` (review I3: not in a card's first 600 ms,
  // not on key repeat, words from before the card are queued as before, slash commands are sent, a plan wants
  // Ctrl+Enter). Attachments without words are still an ordinary message (queued, never an approval).
  const docked = !welcome && !disabled && active ? active.pending[0] : undefined;
  const dockAgent = agentWord(active?.info);
  const hasAttachments = imgs.length > 0 || atts.length > 0 || files.length > 0 || refs.length > 0;
  const dockScope = pane ? `${pane.paneId}|${pane.tileId}` : 'none';
  // when the card on top came, and whether the box had words then (recorded as it first renders: that is when it shows)
  const seenRef = useRef<DockSeen | null>(null);
  const [, setSeenTick] = useState(0);
  if (docked) {
    if (seenRef.current?.requestId !== docked.requestId) seenRef.current = { requestId: docked.requestId, shownAt: Date.now(), carried: !!text.trim() };
  } else if (seenRef.current) seenRef.current = null;
  const setSeen = (patch: Partial<DockSeen>) => { if (seenRef.current) { seenRef.current = { ...seenRef.current, ...patch }; setSeenTick((n) => n + 1); } };
  // a card that came while this conversation was out of sight (another tab / pane / window in front) shows when it
  // comes into view: its first moments start then (review M-9). Something lying over the conversation counts as out
  // of sight too (review I1): the settings page, the automation page, a phone's bottom drawer, the shortcut sheet, the
  // command palette, an in-app dialog (re-review M-4) — closing one gives the
  // focus back to this box, and the Enter right after it must not answer a card the user never saw
  const autoOver = useAutomation((s) => s.open);
  // the 接一个模型 dialog is a dialog too: an Enter meant for it must not answer a docked card underneath
  const dlgOpen = useDialogStore((s) => s.queue.length > 0);
  const connectOpen = useConnect((s) => !!s.req);
  const dialogOpen = dlgOpen || connectOpen;
  const covered = useStore((s) => composerCovered({ settingsOpen: !!s.settingsOpen, automationOpen: autoOver, shortcutsOpen: s.shortcutsOpen, paletteOpen: s.paletteOpen, dialogOpen, mobile: s.mobile, sheetAt: s.sheetAt, dockOpen: s.layout.dock.open, dockTabs: s.layout.dock.tabs.length, inspect: !!s.inspect }));
  const inView = visible && !covered;
  useEffect(() => { if (inView && seenRef.current) setSeen({ shownAt: Date.now() }); }, [inView]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible' && seenRef.current) setSeen({ shownAt: Date.now() }); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  // an Enter the card did not take, said on the card for a moment (and announced: its status line, review M-6)
  const [enterNote, setEnterNote] = useState<{ requestId: string; why: DockWhy } | null>(null);
  useEffect(() => {
    if (!enterNote) return;
    const t = setTimeout(() => setEnterNote(null), 3000);
    return () => clearTimeout(t);
  }, [enterNote]);
  const dockClick = docked ? dockAction(docked, { text, attachments: hasAttachments, seen: seenRef.current, now: Date.now() }) : 'send';
  // words from before the card that an Enter queued: the card offers a button to answer with them instead, while
  // that message is still waiting in the queue (sent already → nothing to take back)
  const queuedOffer = docked && seenRef.current?.queued && active?.queue.some((q) => q.id === seenRef.current?.queued?.id) ? seenRef.current.queued : undefined;
  const dockNote = !docked ? undefined
    : enterNote?.requestId === docked.requestId && !text.trim() ? DOCK_ENTER_IGNORED[enterNote.why]
    : dockClick === 'blocked' ? DOCK_BLOCKED
    : seenRef.current?.carried && text.trim() && !isSlashCommand(text) ? DOCK_CARRIED
    : queuedOffer && !text.trim() ? DOCK_REQUEUED[dockKind(docked)]
    : undefined;

  const addRef = (d: { id: string; title: string }) => {
    setRefs((r) => (r.some((x) => x.id === d.id) ? r : [...r, d]));
    ta.current?.focus();
  };
  // "引用到输入框" from a session menu: only the composer of the focused pane's front tile takes it
  useEffect(() => {
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<ReferenceDetail>).detail;
      if (d.handled || !pane || disabled) return;
      const g = activeGroup(useStore.getState().layout);
      const p = g.panes[pane.paneId];
      if (g.focusedPaneId !== pane.paneId || !p || (p.activeTileId ?? p.tiles[0]?.id) !== pane.tileId) return;
      if (!welcome && active?.sessionId === d.id) { d.reason = '不能引用这个对话自己'; return; }
      d.handled = true;
      addRef({ id: d.id, title: d.title });
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
    // words from before the card stay 「from before」 while the user keeps writing them; once the box is empty,
    // whatever is typed next is typed with the card in view (an answer to it)
    const s = seenRef.current;
    if (s?.carried && !v.trim()) setSeen({ carried: false });
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

  /** send the box's words as the docked card's deny reason (拒绝理由 / 修改意见 / 不回答问题) and clear the box */
  const denyDocked = () => {
    if (!docked) return;
    void useStore.getState().respondPermission(docked.requestId, denyResponse(docked, text));
    onChange('');
  };
  /** the card's 「改用排队的这段话拒绝」: take the queued message back and answer the card with its words */
  const denyQueued = () => {
    const s = seenRef.current;
    if (!docked || !active || !s?.queued) return;
    setSeen({ queued: undefined });
    const q = useStore.getState().recall(active.sessionId, s.queued.id);
    if (!q) { toast('那段话已经发出去了'); return; }
    void useStore.getState().respondPermission(docked.requestId, denyResponse(docked, q.text));
  };

  const doSend = async () => {
    if (!canSend) return;
    const act = docked ? dockAction(docked, { text, attachments: hasAttachments, seen: seenRef.current, now: Date.now() }) : 'send';
    if (act === 'deny') { denyDocked(); return; }
    if (act === 'blocked') { toast(DOCK_BLOCKED); return; }
    if (act !== 'send') return;
    // words from before the card go out as an ordinary (queued) message; the card then offers to take them back
    const requeue = !!docked && !!seenRef.current?.carried && !hasAttachments && !imgs.length && !isSlashCommand(text);
    const t = text;
    if (/^\/goal\s+\S/.test(t.trim())) {
      // the text stays: the user may still want to send it as a plain message, or copy it over there
      if (remote) { toast(REMOTE_GOAL); return; }
      const objective = t.trim().replace(/^\/goal\s+/, '');
      const cwdFor = welcome ? cwd.trim() : active?.cwd ?? '';
      if (!cwdFor) { toast('先选一个项目文件夹'); return; }
      try {
        const g = await ws.request<{ id: string }>({ kind: 'goals.create', objective, cwd: cwdFor, permissionMode: welcome ? wMode : (active?.info?.permissionMode ?? 'acceptEdits'), agent: welcome ? (foreign ? wAgent : undefined) : (active?.info?.agent && active.info.agent !== 'claude' ? active.info.agent : undefined) });
        const started = await ws.request<{ sessionId?: string }>({ kind: 'goals.start', id: g.id });
        onChange(''); // also clears the persisted draft, or the /goal line comes back on reopen
        // the goal runs in a conversation of its own (goals.create takes no conversation): open it here, where its bar
        // (目标 · 第 N 轮 · 查看) shows — otherwise nothing on screen says where it went (review 5 M6); with its folder:
        // the list does not have it yet, and a later resume must not start in the wrong place
        if (started?.sessionId) void useStore.getState().loadHistory(started.sessionId, { cwd: cwdFor });
        // its progress: the right panel's 目标 on a desktop (brought to the front even when it is a tab behind another
        // one). A phone keeps that conversation in front — its bar's 查看 opens the automation page's 目标 tab
        // (showGoals, review 7 M11); with no conversation to show, the page opens right away
        const phone = useStore.getState().mobile;
        if (!phone || !started?.sessionId) showGoals();
        toast(started?.sessionId ? '目标已创建，在新对话里运行' : '目标已创建并启动，进度在「目标」里', true);
      } catch (e: any) { toast(e.message); }
      return;
    }
    const im = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
    if (welcome) {
      if (!cwd.trim()) return toast('请先选择项目文件夹');
      let providerId = provider ? provider.id : 'claude';
      let model = wModel || undefined;
      let effort = wEffortOk;
      // the Claude account is logged out: this would only come back as 「Not logged in」 — connect a model (or pick
      // one already added) and the message goes out on it; closing the dialog keeps the text
      if (needsModel({ provider: providerId, foreignAgent: foreign, loggedIn: useStore.getState().auth?.loggedIn })) {
        const p = await connectModel({ reason: 'send' });
        if (!p) return;
        providerPicked.current = true;
        setWProvider(p.id);
        setWModel('');
        providerId = p.id;
        model = undefined;
        effort = undefined;
      }
      setStarting(true);
      try {
        localStorage.setItem('cw.lastCwd', cwd);
        localStorage.setItem('cw.lastModel', model ?? '');
        localStorage.setItem('cw.lastMode', wMode);
        localStorage.setItem('cw.lastProvider', providerId);
        localStorage.setItem('cw.lastAgent', wAgent);
        if (wAgent !== 'claude' && !agent) throw new Error('选中的 agent 已不可用');
        const id = await openSession({ cwd: cwd.trim(), model, permissionMode: wMode, effort, ultracode: wUltracode && wUltra ? true : undefined, worktree: wWorktree || undefined, providerId, features: foreign ? {} : featDefaults, agent: foreign ? wAgent : undefined }, target);
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
    // the box is empty now: what comes next is typed with the card in view — and its first moments start again, so
    // an Enter right after this one (a double press) does not answer the card (review M-3)
    if (docked && seenRef.current) setSeen({ carried: false, shownAt: Date.now() });
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
      const sid = active.sessionId;
      const before = useStore.getState().open[sid]?.queue.length ?? 0;
      await send(sid, full, im, false, [...atts, ...uploaded]);
      if (requeue && seenRef.current?.requestId === docked?.requestId) {
        const q = useStore.getState().open[sid]?.queue ?? [];
        const mine = q.length > before ? q[q.length - 1] : undefined;
        setSeen({ carried: false, queued: mine && mine.text === full ? { id: mine.id, text: mine.text } : undefined });
      }
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
    if (matches.length && slashQuery !== null && !imeComposing(e.nativeEvent)) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPalIdx((i) => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPalIdx((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text !== `/${matches[palIdx].name}`)) { e.preventDefault(); pickCmd(matches[palIdx].name); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !imeComposing(e.nativeEvent)) {
      e.preventDefault();
      if (docked) {
        // (an Enter reaching the box while something covers it: the card is not on screen, so it is in its first moments)
        const seen = inView || !seenRef.current ? seenRef.current : { ...seenRef.current, shownAt: Date.now() };
        const { act, why } = dockDecide(docked, { text, attachments: hasAttachments, seen, now: Date.now(), enter: { repeat: e.repeat, ctrl: e.ctrlKey || e.metaKey } });
        // an empty box under a docked card: Enter is the card's main button (允许一次 ↵ / 提交回答; a plan: Ctrl+Enter)
        if (act === 'primary') { runDockPrimary(primaryKey(dockScope, docked.requestId)); return; }
        if (act === 'ignore') { if (why) setEnterNote({ requestId: docked.requestId, why }); return; }
      }
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
  const folderInput = useRef<HTMLInputElement>(null);
  // 添加文件夹 (+ menu): the same shape a dropped folder has — every file with its path under the folder
  const onFolderPicked = (list: FileList | null) => {
    const fl = Array.from(list ?? []);
    if (!fl.length) return;
    if (remote) { toast(REMOTE_ATTACH); return; }
    // node_modules / .git / dist… are dropped before the 500 cap, same rule as a dropped folder
    const { files: picked, top, truncated, skipped } = pickFolderFiles(fl);
    if (!picked.length) { toast(`文件夹 ${top} 里只有依赖 / 构建产物 / .git，没有可附加的文件`); return; }
    setFiles((s) => [...s, ...picked].slice(0, 500));
    toast(`已附加文件夹 ${top}（${picked.length} 个文件${truncated ? '，已截断到 500' : ''}${skipped ? `，跳过 node_modules / .git 等 ${skipped} 个` : ''}）`, true);
  };

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
  // the unified model menu inside a session: same profile → setModel; another profile → the invisible
  // restart of session.setProvider, started directly on the picked model; another agent → the hand-over
  const [swapping, setSwapping] = useState(false);
  const liveAgent: AgentKind = info?.agent ?? 'claude';
  // a conversation not running yet has no info: its agent comes from the list
  const sessionAgent: AgentKind = info?.agent ?? sessions.find((s) => s.sessionId === active?.sessionId)?.agent ?? 'claude';
  const liveProvider = info?.providerId && info.providerId !== 'claude' ? info.providerId : 'claude';
  const liveAgentDefault = liveAgent !== 'claude' ? agents.find((a) => a.kind === liveAgent)?.model || undefined : undefined;
  // the account's default model by name for a chip with no model (final review §9 #2): this conversation's CLI says
  // it (its own login only), else the one remembered from the last conversation that did
  const accountDefault = useAccountDefault(liveAgent === 'claude' && liveProvider === 'claude' ? info?.models : undefined);
  /** false = nothing happened (refused / cancelled / failed): the menu then does not record it as recent */
  const pickLive = async (it: ModelMenuItem): Promise<boolean> => {
    if (!active || swapping) return false;
    const act = routePick(it, { agent: liveAgent, currentProvider: remote ? 'claude' : liveProvider, currentModel: info?.model, remote, busy, providers, agentDefault: liveAgentDefault });
    if (act.kind === 'none') return true;
    if (act.kind === 'error') { toast(act.message); return false; }
    if (act.kind === 'setModel') {
      // with the provider this pick was for: a switch from another window in between drops it (server-side check)
      try { await ws.request({ kind: 'session.setModel', sessionId: active.sessionId, model: act.model, providerId: remote ? undefined : liveProvider }); toast(switchedNote(it.label, active.conv.items.length > 0), true); return true; } catch (e: any) { toast(e.message); return false; }
    }
    if (act.kind === 'handover') {
      // the same hand-over as ··· 「交给其它 Agent 继续」 (same confirm, same refresh), on the picked model
      const summary = sessions.find((s) => s.sessionId === active.sessionId) ?? { sessionId: active.sessionId, title: '', cwd: active.cwd, lastModified: 0 };
      setSwapping(true);
      try { return await handOver(summary, act.agent, act.model, it.display); } finally { setSwapping(false); }
    }
    if (act.confirm && !(await dlg.confirm('切换供应商？', { message: '对话正在运行，当前这一轮会被中断。换供应商会重启对话进程，历史保留。', okLabel: '切换' }))) return false;
    setSwapping(true);
    try {
      await ws.request({ kind: 'session.setProvider', sessionId: active.sessionId, providerId: act.providerId, model: act.model });
      toast(switchedNote(it.label, active.conv.items.length > 0), true);
      return true;
    } catch (e: any) { toast(e.message); return false; } finally { setSwapping(false); }
  };
  // a conversation that is not running: a pick only changes what the next send resumes it with. The menu lists the
  // profiles this agent can use and greys the ones it cannot right now (the same fit check `session.open` runs —
  // `profileFitError`), and routePick refuses those; another agent's model is the same hand-over as a live one
  const resumeAgentDefault = sessionAgent !== 'claude' ? agents.find((a) => a.kind === sessionAgent)?.model || undefined : undefined;
  const pickResume = async (it: ModelMenuItem, v: { providerId: string; model?: string }): Promise<boolean> => {
    if (!active || swapping) return false;
    const act = routePick(it, { agent: sessionAgent, currentProvider: remote ? 'claude' : v.providerId, currentModel: v.model, remote, busy: false, providers, agentDefault: resumeAgentDefault });
    if (act.kind === 'none') return true;
    if (act.kind === 'error') { toast(act.message); return false; }
    if (act.kind === 'handover') {
      const summary = sessions.find((s) => s.sessionId === active.sessionId) ?? { sessionId: active.sessionId, title: '', cwd: active.cwd, lastModified: 0 };
      setSwapping(true);
      try { return await handOver(summary, act.agent, act.model, it.display); } finally { setSwapping(false); }
    }
    // '' = the default (the account's `default` alias, or the profile's own): the resume then sends no model
    if (act.kind === 'setModel') setResume(active.sessionId, { model: act.model === 'default' ? '' : act.model });
    else setResume(active.sessionId, { providerId: act.providerId ?? OWN_PROVIDER, model: act.model ?? '' });
    return true;
  };
  const pickWelcome = (it: ModelMenuItem) => {
    providerPicked.current = true;
    if (it.agent && it.agent !== wKind) {
      // another agent: switch agent (the old agent picker), its default effort — on the provider its section lists
      // (settings → Agents 「新对话用」), else its own login
      setWAgent(it.agent);
      setWProvider(it.providerId || 'claude');
      setWModel(it.model);
      setWEffort('');
      return true;
    }
    setWProvider(it.providerId);
    setWModel(it.model);
    return true;
  };
  const setEffort = (effort: EffortLevel) => active && ws.request({ kind: 'session.setEffort', sessionId: active.sessionId, effort }).catch((e) => toast(e.message));
  const setUltracode = (on: boolean) => active && ws.request({ kind: 'session.setUltracode', sessionId: active.sessionId, on }).catch((e) => toast(e.message));

  // the other agents as sources in the model menu (Claude Code included when another agent is current)
  const otherAgents = useMemo<AgentSource[]>(() => {
    const list: AgentSource[] = agents.filter((a) => a.enabled !== false).map((a) => {
      // Claude's is the new-conversation default (settings → 供应商), the others' their own 「新对话用」
      const pid = a.kind === 'claude' ? (settings.defaultProviderId as string | undefined) : a.providerId;
      const via = usableProfile(providers, pid, { agent: a.kind, engine, gatewayGroups: gatewayView.groups, gatewayEnabled: gatewayView.enabled });
      return { kind: a.kind, name: a.name, installed: a.installed !== false, models: a.models, defaultModel: a.model || undefined, ...(via ? { provider: via } : {}) };
    });
    if (!list.some((a) => a.kind === 'claude')) list.unshift({ kind: 'claude', name: 'Claude Code', installed: true });
    return list;
  }, [agents, providers, engine, gatewayView.groups, gatewayView.enabled, settings.defaultProviderId]);

  const recentDirs = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].slice(0, 8), [sessions]);
  const folderChips = useMemo(() => { const m = new Map<string, number>(); for (const f of files) { const top = f.rel.includes('/') ? f.rel.split('/')[0] : null; if (top) m.set(top, (m.get(top) ?? 0) + 1); } return m; }, [files]);

  // the capabilities: on the welcome page the ones the new conversation will get (removable); in a running one
  // what it was started with (fixed — a launch parameter)
  const claudeHere = welcome ? !foreign : sessionAgent === 'claude';
  const sessionFeatures = info?.features ?? NO_FEATURES;
  const tags = welcome ? (claudeHere ? capabilityTags(featDefaults) : []) : capabilityTags(sessionFeatures);
  const hasChips = imgs.length > 0 || atts.length > 0 || files.length > 0 || refs.length > 0 || !!upload || tags.length > 0 || (welcome && !!wWorktree);
  const insertGoal = () => { const v = text.trim() ? `/goal ${text.trim()}` : '/goal '; onChange(v); requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }); };

  // ---- the row's pieces
  const plus = (
    <PlusMenu claude={claudeHere} live={!welcome} remote={remote} disabled={disabled}
      features={welcome ? featDefaults : sessionFeatures} onFeatures={setFeatures} selfId={welcome ? undefined : active?.sessionId}
      onFiles={() => fileInput.current?.click()} onFolder={() => folderInput.current?.click()} onReference={addRef} onGoal={insertGoal} />
  );
  const send_ = busy ? (
    <button className="send stop" data-id={BAR_ID.send} title="中断 (Esc)" onClick={() => active && interrupt(active.sessionId)} aria-label="中断"><Icon name="stop" size={13} /></button>
  ) : (
    <button className="send" data-id={BAR_ID.send} disabled={!canSend} onClick={doSend} title="发送 (Enter)" aria-label="发送">{starting || upload ? <span className="spinner" /> : <Icon name="send" size={16} />}</button>
  );
  const steer = docked && (dockClick === 'deny' || dockClick === 'blocked') ? (
    <button className="steer deny" data-id={BAR_ID.steer} disabled={dockClick === 'blocked'} title={dockClick === 'blocked' ? DOCK_BLOCKED : `拒绝这次请求，并把这段话告诉 ${dockAgent}（Enter）`} onClick={denyDocked}>{DOCK_SEND[dockKind(docked)]} <Icon name="send" size={12} /></button>
  ) : busy && canSend && active ? (
    <button className="steer" data-id={BAR_ID.steer} title={`${TERMS.steer}：不等这一轮结束，马上把这句话告诉 Claude`} aria-label={TERMS.steer} onClick={async () => { const t = text; setText(''); setDraft(active.sessionId, ''); await send(active.sessionId, t, undefined, true).catch((e) => toast(e.message)); }}>插话 <Icon name="send" size={12} /></button>
  ) : null;
  const mic = speechOk && !mobile ? (
    <button data-id={BAR_ID.mic} className={clsx('icon-btn', listening && 'active')} title={listening ? '停止语音输入' : '语音输入（浏览器识别）'} onClick={toggleVoice} aria-label="语音输入"><Icon name="mic" size={15} /></button>
  ) : null;

  let model: React.ReactNode = null, permission: React.ReactNode = null, meter: React.ReactNode = null, status: React.ReactNode = null;
  if (welcome) {
    const t = modelChipText({ agent: wKind, agentName: agent?.name, providers, providerId: provider?.id, model: wModel, builtin: wBuiltin, agentDefault: agent?.model || undefined, efforts: wEfforts, effort: wEffortOk, defaultEffort: wView.defaultLevel, ultracode: wUltracode && wUltra, accountDefault });
    model = (
      <ModelChip
        agent={wKind}
        current={{ providerId: provider ? provider.id : 'claude', model: wModel }}
        label={t.main}
        suffix={t.suffix}
        title={`${t.main}${t.isDefault ? '（默认）' : ''}${t.suffix ? ` · ${t.suffix}` : ''}\n用哪个模型、想多深：Agent、供应商、模型、${TERMS.effort}、${TERMS.ultracode}都在这里`}
        builtin={wBuiltin}
        builtinTitle={agent ? `${agent.name} 账号` : 'Claude 账号'}
        agentDefault={agent?.model || undefined}
        otherAgents={otherAgents}
        intelligence={{ levels: wEfforts, value: wEffortOk, defaultLevel: wView.defaultLevel, mode: wView.mode, onChange: setWEffort }}
        ultracode={wUltracode ? { on: wUltra, onChange: setWUltra } : undefined}
        onPick={pickWelcome}
      />
    );
    permission = <PermissionChip mode={wMode} compact={mobile} onPick={(m) => { modeTouched.current = true; setWMode(m); }} />;
  } else if (liveOk) {
    const ultraOk = info.supportsUltracode !== false && !!CATALOG[liveAgent]?.supportsUltracode;
    const liveView = claudeEffortView({ agent: liveAgent, providers, providerId: remote ? 'claude' : liveProvider, model: info.model, runtime: info.runtime });
    const defaultEffort = liveView.defaultLevel;
    const t = modelChipText({ agent: liveAgent, agentName: info.agentName, providers, providerId: remote ? 'claude' : liveProvider, providerName: info.providerName, model: info.model, builtin: liveProvider === 'claude' && info.models?.length ? info.models : undefined, agentDefault: liveAgentDefault, efforts: liveEfforts, effort: info.effort, defaultEffort, ultracode: ultraOk && !!info.ultracode, accountDefault });
    const remoteLabel = `${info.providerName ? `${info.providerName} / ` : ''}${info.models?.find((m) => m.value === info.model)?.displayName ?? (shortModel(info.model) || '模型')}`;
    model = (
      <ModelChip
        agent={liveAgent}
        current={{ providerId: remote ? 'claude' : liveProvider, model: info.model }}
        label={remote ? remoteLabel : t.main}
        suffix={t.suffix}
        title={remote ? '模型（其它机器上的对话：换供应商请在那台机器上操作）' : `${t.main}${t.isDefault ? '（默认）' : ''}${t.suffix ? ` · ${t.suffix}` : ''}\n同一供应商直接换模型；换供应商会无感重启对话；选其它 Agent 的模型 = 交给它继续`}
        builtin={(remote || liveProvider === 'claude') && info.models?.length ? info.models : undefined}
        builtinTitle={remote ? info.providerName ?? info.agentName ?? '模型' : liveAgent === 'claude' ? 'Claude 账号' : `${info.agentName ?? liveAgent} 账号`}
        agentDefault={liveAgentDefault}
        lockProvider={remote ? 'claude' : undefined}
        lockNote="其它机器上的对话：只能换模型，换供应商请在那台机器上操作"
        otherAgents={remote ? undefined : otherAgents}
        intelligence={{ levels: liveEfforts, value: info.effort, defaultLevel: defaultEffort, mode: liveModel?.effortMode ?? liveView.mode, onChange: setEffort }}
        ultracode={ultraOk ? { on: !!info.ultracode, onChange: setUltracode } : undefined}
        busy={swapping}
        disabled={swapping}
        onPick={pickLive}
      />
    );
    permission = <PermissionChip mode={info.permissionMode ?? 'default'} compact={mobile} onPick={setMode} />;
  } else if (active && !disabled && active.state !== 'starting') {
    // not running (history, reaped, crashed — every conversation after a restart): the chips show what the next
    // send resumes it with, and a pick there changes that (final review §9 #1)
    const v = resumeView(active, sessionMeta[active.sessionId]);
    const rAgent = sessionAgent;
    const rProvider = remote ? 'claude' : v.providerId;
    const rP = providers.find((p) => p.id === rProvider);
    const rView = claudeEffortView({ agent: rAgent, providers, providerId: rProvider, model: v.model, runtime: rP ? effectiveRuntime(rP, engine) : undefined });
    const rEfforts = rView.levels;
    const rUltraOk = !remote && rView.ultracode;
    const t = modelChipText({ agent: rAgent, agentName: agents.find((a) => a.kind === rAgent)?.name, providers, providerId: rProvider, model: v.model, agentDefault: resumeAgentDefault, efforts: rEfforts, effort: v.effort, defaultEffort: rView.defaultLevel, ultracode: rUltraOk && v.ultracode, accountDefault });
    const sid = active.sessionId;
    // nothing picked: the chip names the default the resume will really get; the transcript's last model is a hint
    const lastHint = !v.model && v.lastModel ? `\n上次回答用的是 ${modelsFor(rAgent, [{ id: v.lastModel }])[0]?.displayName ?? v.lastModel}` : '';
    model = (
      <ModelChip
        agent={rAgent}
        current={{ providerId: rProvider, model: v.model }}
        label={t.main}
        suffix={t.suffix}
        title={`${t.main}${t.isDefault ? '（默认）' : ''}${t.suffix ? ` · ${t.suffix}` : ''}${lastHint}\n对话没在运行：发送后用这里选的模型继续${remote ? '' : '；选其它 Agent 的模型 = 交给它继续'}`}
        builtinTitle={rAgent === 'claude' ? 'Claude 账号' : `${agents.find((a) => a.kind === rAgent)?.name ?? rAgent} 账号`}
        agentDefault={resumeAgentDefault}
        lockProvider={remote ? 'claude' : undefined}
        lockNote="其它机器上的对话：只能换模型，换供应商请在那台机器上操作"
        otherAgents={remote ? undefined : otherAgents}
        intelligence={{ levels: rEfforts, value: v.effort, defaultLevel: rView.defaultLevel, mode: rView.mode, onChange: (effort) => setResume(sid, { effort }) }}
        ultracode={rUltraOk ? { on: v.ultracode, onChange: (on) => setResume(sid, { ultracode: on }) } : undefined}
        busy={swapping}
        disabled={swapping}
        onPick={(it) => pickResume(it, v)}
      />
    );
    permission = <PermissionChip mode={v.permissionMode} compact={mobile} onPick={(m) => setResume(sid, { permissionMode: m })} />;
    status = <span className="cb-status opt" title="对话没在运行，发送后按这里选的模型和权限继续">发送后继续</span>;
  } else if (active) {
    status = <span className="cb-status">{disabled ? '对话已删除' : '启动中…'}</span>;
  }
  if (!welcome && active) meter = <ContextMeter sessionId={active.sessionId} />;

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
        {/* a docked card takes the run card's place (spec §4.2: 「等确认时被权限卡替代」) */}
        {active && !welcome && (docked
          ? <PermissionDock sessionId={active.sessionId} reason={text} onReasonUsed={() => onChange('')} scope={dockScope} note={dockNote} onDenyQueued={queuedOffer ? denyQueued : undefined} />
          : <RunCard sessionId={active.sessionId} />)}
        <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {hasChips && (
            <div className="attach">
              {tags.map((t) => (
                <span key={`t${t.key}`} className={clsx('cap-tag', !welcome && 'fixed')} data-cap={t.key} title={welcome ? t.title : `${t.title}\n这个对话开始时就开着`}>
                  <Icon name={t.icon} size={12} /> {t.label}
                  {welcome && <button aria-label={`关闭${t.label}`} onClick={() => setFeatures(withoutTag(featDefaults, t.key))}><Icon name="close" size={10} /></button>}
                </span>
              ))}
              {welcome && wWorktree && (
                <span className="cap-tag" data-cap="worktree" title={`新对话在项目的独立副本（git worktree「${wWorktree}」）里运行`}>
                  <Icon name="branch" size={12} /> 独立副本 · {wWorktree}
                  <button aria-label="不用独立副本" onClick={() => setWWorktree('')}><Icon name="close" size={10} /></button>
                </span>
              )}
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
            placeholder={disabled ? '对话已被删除，不能继续' : docked ? DOCK_PLACEHOLDER[dockKind(docked)](dockAgent) : welcome ? '描述一个任务，或者问个问题。输入 / 查看命令，拖入文件作为附件' : active?.state === 'history' ? '发送即可继续这个对话…' : busy ? '运行中，输入会排队 · Esc 中断' : `回复 ${info?.agentName && info.agent !== 'claude' ? info.agentName : 'Claude'}… 输入 / 查看命令，拖入文件作为附件`}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const fl = Array.from(e.target.files ?? []); void addImages(fl.filter((f) => f.type.startsWith('image/'))); if (remote && fl.some((f) => !f.type.startsWith('image/'))) { toast(REMOTE_ATTACH); e.target.value = ''; return; } setFiles((s) => [...s, ...fl.filter((f) => !f.type.startsWith('image/')).map((f) => ({ file: f, rel: f.name }))]); e.target.value = ''; }} />
          <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(e) => { onFolderPicked(e.target.files); e.target.value = ''; }} />
          <ComposerBar
            plus={plus}
            project={welcome ? <ProjectChip cwd={cwd} recent={recentDirs} onPick={setCwd} onBrowse={() => void pickDir()} worktree={wWorktree} onWorktree={setWWorktree} /> : null}
            branch={welcome && !mobile ? <BranchChip cwd={cwd} /> : null}
            status={status}
            meter={meter}
            model={model}
            permission={permission}
            mic={mic}
            steer={steer}
            send={send_}
          />
        </div>
      </div>
    </div>
  );
}
