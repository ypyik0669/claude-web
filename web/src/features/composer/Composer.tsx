import { cloneElement, isValidElement, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ownClaudeName } from '@/store/auth';
import { ModeChangedError, useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { clsx, shortModel } from '@/util';
import { parsePeerId, policyOfModel, type AgentKind, type AttachmentRef, type EffortLevel, type PeerInfo, type PermissionMode, type PermissionRequestEvent, type SessionFeatures, type WslDistro, wslToWin } from '@shared';
import { MachineChip } from './MachineChip';
import { machineOf } from './machine';
import { installClaudeInWsl } from '@/features/remote/wsl-install';
import { bundleParts, compressImage, expandDataTransfer, fmtSize, isLongPaste, pasteAsAttachment, uploadAttachment, type DroppedFile, type PendingBundle, type PendingImage } from '@/model/attachments';
import { pickFolderFiles } from '@/model/attachment-filter';
import { StatusStrip, noLoginChipShown } from '@/features/chat/StatusStrip';
import { QueueCards } from '@/features/chat/QueueCards';
import { SideChat } from '@/features/chat/SideChat';
import { openSideChat } from '@/features/chat/side-chat';
import { parseBtw } from '@/features/chat/side-chat-model';
import { atQueryAt, pickAt } from './at-mention';
import { RunCard } from '@/features/chat/RunCard';
import { BackgroundPill } from '@/features/background/BackgroundPill';
import { PermissionDock, runDockPrimary, setAskNote } from '@/features/chat/PermissionCards';
import { denyResponse, dockAction, dockDecide, dockKind, dockPlaceholder, isSlashCommand, primaryKey, splitPending, type DockSeen, type DockWhy } from '@/features/chat/permission-dock';
import { attachmentFolderPath, joinPath, projectRoots } from '@/features/paths';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { haptic } from '@/ui/haptics';
import { CATALOG, effortLevels, modelsFor } from '@catalog';
import { usePaneCtx } from '@/store/paneContext';
import { activeGroup } from '@/model/layout';
import { sessionRefMarker } from '@/model/conversation';
import { SessionRefChip } from '@/features/chat/ChatView';
import { REFERENCE_EVENT, handOver, type ReferenceDetail } from '@/features/sidebar/session-actions';
import { ModelChip } from '@/features/models/ModelMenu';
import { EffortChip, type EffortChipProps } from '@/features/models/EffortChip';
import { SubagentChip, subagentLabel } from '@/features/models/SubagentChip';
import { subagentModelFor } from '../../../../server/src/models/subagent';
import { OWN_PROVIDER, agentModels, effectiveRuntime, routingPolicyLabel, usableProfile, type AgentSource, type ModelMenuItem } from '@/features/models/menu';
import { mergeResume, resumeView } from '@/store/reopen';
import { routePick, switchedNote } from '@/features/models/route';
import { claudeEffortView, modelChipText } from '@/features/models/intelligence';
import { useAccountDefault } from '@/features/models/account-default';
import { providersLoaded, useGatewayStatus } from '@/features/models/data';
import { needsModel, welcomeProvider } from './welcome-provider';
import { connectModel, useConnect } from '@/features/providers/ConnectModel';
import { openAddSource, useAddSource } from '@/features/gateway/add-source';
import { dlg, useDialogStore } from '@/ui/dialog';
import { DOCK_BLOCKED, DOCK_CARRIED, DOCK_ENTER_IGNORED, DOCK_REQUEUED, DOCK_SEND, EFFORT_LABEL, TERMS, ULTRACODE } from '@/ui/terms';
import { showGoals } from '@/features/workbench/right-panel';
import { ComposerBar, ComposerUnder } from './ComposerBar';
import { ConvStatsLine } from './ConvStatsLine';
import { PlusMenu } from './PlusMenu';
import { PermissionChip } from './PermissionChip';
import { nextPermissionMode } from '@/ui/terms';
import { HandedOffBar } from '@/features/cloud/HandoffDialog';
import { BranchChip, ProjectChip } from './ProjectChip';
import { ContextMeter } from './ContextMeter';
import { BAR_ID } from './ids';
import { FEATURE_DEFAULTS_KEY, LEGACY_FEATURES_KEY, afterStart, capabilityTags, migrateFeatureDefaults, usable, withoutTag } from './capabilities';
import { FILL_EVENT, MENTION_EVENT, type FillDetail, type MentionDetail } from './fill';
import { mentionText } from './at-mention';
import { QUOTE_EVENT, withLine, withQuote, type QuoteDetail } from './quote';
import { applyStarter, initialCwd } from '@/features/home/model';
import { usePageOpen } from '@/features/sections';
import { composerCovered } from './covered';
import { glowing, sendFace } from './send-state';
import { dateLocale, tr } from '@/i18n';
import { ProcessGlyph } from '@/themes/ProcessGlyph';
import { onRecorded, openPicker } from '@/features/recording/recorder';
import { framesState, withFrames, withoutFrame, type ComposerRecording } from '@/features/recording/pending';
import { extractKeyframes } from '@/features/recording/extract';
import { fmtDuration } from '@/features/recording/keyframes';
import { pickFolder } from '@/ui/pick-folder';
// review X1: the SSH dialog loads when it is opened
const AddSshDialog = lazy(() => import('@/features/remote/AddSshDialog').then((m) => ({ default: m.AddSshDialog })));

// sessions on another machine: uploads land on this machine's disk, out of the remote agent's reach
const REMOTE_ATTACH = tr('附件在本机，远端读不到，请粘贴内容（图片可以直接发）');
// goals run on THIS machine (GoalService drives a local runner): it cannot drive a conversation over there
const REMOTE_GOAL = tr('其它机器上的对话不能在这里设定目标（目标由本机驱动）。可以到那台机器上设定，或先「交给本机的 Agent 继续」');
const NO_FEATURES: SessionFeatures = {};
const isFeatures = (v: unknown): v is SessionFeatures => !!v && typeof v === 'object' && !Array.isArray(v);

const NO_PENDING_LOCAL: PermissionRequestEvent[] = [];

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
/** fast mode's reasons that no switch here can change (another provider, turned off by the environment): no row */
const FAST_NEVER = new Set(['not_first_party', 'disabled_by_env']);

function fastOffText(reason: string): string {
  switch (reason) {
    case 'free': return tr('免费账号没有');
    case 'extra_usage_disabled': return tr('要先开额外用量');
    case 'model_not_allowed': return tr('这个模型没有');
    case 'network_error': return tr('暂时连不上');
    case 'sdk_opt_in_required': case 'preference': return '';
    case 'pending': return tr('检查中…');
    default: return tr('现在不可用');
  }
}

/**
 * `variant: 'bot'`: the box in a 值班 Bot's main conversation — what it runs with is the bot's (its policy decides the
 * permissions), so no model / 子代理 / 强度 / permission chips, no Shift+Tab mode step, and the + menu keeps only what
 * goes into the message (files, folder, a reference, 录屏, 斜杠命令).
 */
export function Composer({ welcome = false, target, disabled = false, visible = true, variant }: { welcome?: boolean; target?: { paneId: string; tileId: string }; disabled?: boolean; visible?: boolean; variant?: 'bot' }) {
  const bot = variant === 'bot' && !welcome;
  const active = useScopedSession();
  const ownName = useStore((s) => ownClaudeName(s.auth));
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const setDraft = useStore((s) => s.setDraft);
  const setResume = useStore((s) => s.setResume);
  const setSubagentModel = useStore((s) => s.setSubagentModel);
  const saveDraft = useStore((s) => s.saveDraft);
  const openSession = useStore((s) => s.openSession);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const mobile = useStore((s) => s.mobile);
  // 交给常开机器继续 (stage F1): handed to another machine, read-only here
  const handedOff = useStore((s) => (active ? s.sessionMeta[active.sessionId]?.handedOff : undefined));
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(welcome ? '' : active?.draft ?? '');
  const [imgs, setImgs] = useState<PendingImage[]>([]);
  const [subOpen, setSubOpen] = useState(0);
  const [effortOpen, setEffortOpen] = useState(0);
  const [atts, setAtts] = useState<AttachmentRef[]>([]); // inline text attachments
  // a picture with its words, one chip (the browser's 页面标注): handed over through the store's inbox
  const [bundles, setBundles] = useState<PendingBundle[]>([]);
  // 录屏 (stage E3): finished recordings of this box, uploaded with keyframes on send (the keyframes are taken at once
  // and shown under the chip, each removable: what is sent is what was seen)
  const [recordings, setRecordings] = useState<ComposerRecording[]>([]);
  const [files, setFiles] = useState<DroppedFile[]>([]); // uploaded on send
  const [refs, setRefs] = useState<{ id: string; title: string }[]>([]); // referenced sessions → <session-ref /> markers on send
  const pane = usePaneCtx();
  const [upload, setUpload] = useState<{ done: number; total: number; name: string } | null>(null);
  // 发送前核对权限: the mode the chip of a conversation that is not running shows (set while rendering it), and the
  // short notice when a send was refused because the conversation would really resume in another one
  const shownMode = useRef<PermissionMode | undefined>(undefined);
  // 智能路由: the model this conversation really got last (shown after the strategy on the chip)
  const routed = useStore((s) => (active ? s.routed[active.sessionId] : undefined));
  const [modeNotice, setModeNotice] = useState<{ sid: string; text: string } | null>(null);
  const [palIdx, setPalIdx] = useState(0);
  // Shift+Tab in the empty box: the next permission mode (like the CLI) — set by whichever chip is drawn below
  const permCycle = useRef<(() => void) | null>(null);
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
  // 新对话选机器: '' = this computer, 'wsl:<distro>' = a WSL distro, else a federation peer's id (the welcome page only)
  const [wMachine, setWMachine] = useState('');
  const wm = machineOf(wMachine);
  const wPeer = wm.kind === 'peer' ? wm.id : '';
  const wWsl = wm.kind === 'wsl' ? wm.distro : '';
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [addSsh, setAddSsh] = useState(false);
  const wslOf = (d: string) => wslDistros.find((x) => x.name === d);
  /** the machine menu opened (Windows desktop): the distros, then a check of each as it comes back */
  const loadWsl = () => {
    if (!desktop || !/win/i.test(desktop.platform ?? '')) return;
    ws.request<{ available: boolean; distros: WslDistro[] }>({ kind: 'wsl.list' }).then((r) => {
      if (!r?.available) { setWslDistros([]); return; }
      setWslDistros((cur) => r.distros.map((d) => cur.find((c) => c.name === d.name && c.claude !== null) ?? d));
      for (const d of r.distros) ws.request<WslDistro>({ kind: 'wsl.check', distro: d.name }).then((c) => setWslDistros((cur) => cur.map((x) => (x.name === c.name ? c : x)))).catch(() => {});
    }).catch(() => setWslDistros([]));
  };
  const installWsl = async (d: string) => {
    const c = await installClaudeInWsl(d).catch((e) => { toast(String(e?.message ?? e)); return null; });
    if (c) setWslDistros((cur) => cur.map((x) => (x.name === c.name ? c : x)));
  };
  // 只聊天: this new conversation only, never a stored default (a default would quietly take the tools from every one)
  const [wChatOnly, setWChatOnly] = useState(false);
  const liveChatOnly = useStore((s) => !!(active && s.sessionMeta[active.sessionId]?.chatOnly));
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  useEffect(() => {
    if (!welcome) return;
    ws.request<PeerInfo[]>({ kind: 'peers.list' }).then((l) => setPeers(Array.isArray(l) ? l : [])).catch(() => setPeers([]));
  }, [welcome]);
  // the 子代理 chip on the welcome page: picked for one provider (another one takes its own default); null = the default
  const [wSub, setWSub] = useState<{ providerId: string; model: string } | null>(null);
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
  const wProviderId = provider ? provider.id : 'claude';
  // a whole pick: switching the new conversation to another provider keeps it
  const wSubModel = subagentModelFor({ recorded: wSub ?? undefined, settings, providerId: wProviderId });
  // (what the agent said it offers this account comes first: the catalog goes stale with every release)
  const wBuiltin = agent && (agent.reportedModels?.length || !modelsFor(agent.kind).length) ? agentModels(agent) : undefined;
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
  // (a stored default for something this machine cannot do — 操控电脑 off Windows — is left out)
  const canComputer = useStore((s) => s.engine?.computerUse === true);
  const capEnv = useMemo(() => ({ computer: canComputer }), [canComputer]);
  const featDefaults: SessionFeatures = useMemo(() => (isFeatures(storedFeatures) ? usable(storedFeatures, capEnv) : NO_FEATURES), [storedFeatures, capEnv]);
  const metaLoaded = useStore((s) => s.metaLoaded);
  useEffect(() => { if (metaLoaded) migrateFeaturesOnce(); }, [metaLoaded]);
  const setFeatures = (f: SessionFeatures) => { void useStore.getState().setSetting(FEATURE_DEFAULTS_KEY, f).catch((e) => toast(e.message)); };
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  // the desktop app has the API but not the recognition service behind it (Electron 44: `network` on every start, mic
  // allowed — phase 2 spec §6): no microphone there rather than one that always fails
  const speechOk = !desktop && typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
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
    rec.lang = dateLocale();
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

  // a starter / the 入门清单 fills this (welcome) composer: text, project, focus (fill.ts); a 值班 Bot's box takes
  // only what names its tile (the profile column's 「编辑」 of a routine)
  const textRef = useRef(text);
  textRef.current = text;
  const fillTile = welcome ? target?.tileId : bot ? pane?.tileId : undefined;
  useEffect(() => {
    if (!fillTile) return;
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<FillDetail>).detail;
      if (bot ? d.tileId !== fillTile : d.tileId && d.tileId !== fillTile) return;
      if (d.cwd) setCwd(d.cwd);
      if (d.text !== undefined) onChange(applyStarter(textRef.current, d.text));
      if (d.text !== undefined || d.focus) requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener(FILL_EVENT, on);
    return () => window.removeEventListener(FILL_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillTile, bot]);

  // 文件右键 → 加到下一条消息: this conversation's box takes `@path` (relative to its folder when inside it)
  useEffect(() => {
    if (welcome || !active) return;
    const sid = active.sessionId, cwdNow = active.cwd;
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<MentionDetail>).detail;
      if (d.handled || d.sessionId !== sid || disabled) return;
      d.handled = true;
      setText((cur) => { const next = mentionText(cur, d.path, cwdNow); setDraft(sid, next); return next; });
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener(MENTION_EVENT, on);
    return () => window.removeEventListener(MENTION_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcome, active?.sessionId, active?.cwd, disabled]);

  // 页面标注 and the like: attachments handed to this conversation through the store wait there until a composer of
  // it is on screen; the first one that is takes them
  const inbox = useStore((s) => (welcome || !active ? undefined : s.composerInbox[active.sessionId]));
  useEffect(() => {
    if (!inbox?.length || !active || disabled || !visible) return;
    const got = useStore.getState().takeComposerAttachments(active.sessionId);
    if (got.length) setBundles((cur) => [...cur, ...got]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox, active?.sessionId, disabled, visible]);

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

  // /btw is ours (旁聊, never sent to the engine); the engine's own list may carry one too
  const engineCommands = active?.info?.slashCommands;
  const commands = useMemo(() => [{ name: 'btw', description: tr('旁聊：问一个不进对话的小问题'), argumentHint: tr('问题') }, ...(engineCommands ?? []).filter((c) => c.name !== 'btw')], [engineCommands]);
  const slashQuery = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  const matches = useMemo(() => (slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 40)), [slashQuery, commands]);
  useEffect(() => setPalIdx(0), [slashQuery]);
  // @ file completion (phase 2 spec §4): the @word at the caret, the project's files matching it (not for a
  // conversation on another machine — its files are there)
  const [caret, setCaret] = useState(0);
  const [atClosed, setAtClosed] = useState<number | null>(null);
  const atRoot = welcome ? (wPeer ? '' : cwd.trim()) : remote ? '' : active?.cwd ?? '';
  const atQuery = atRoot && slashQuery === null ? atQueryAt(text, caret) : null;
  const atOpen = atQuery && atQuery.start !== atClosed ? atQuery : null;
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [atIdx, setAtIdx] = useState(0);
  // a project with extra folders: those are searched too, their files given as absolute paths (stage C2)
  const atRoots = useMemo(() => (atRoot ? projectRoots(atRoot, workspaces) : []), [atRoot, workspaces]);
  useEffect(() => {
    if (!atOpen) { setAtFiles([]); return; }
    let live = true;
    const t = setTimeout(() => {
      Promise.all(atRoots.map((root, i) => ws.request({ kind: 'fs.findFiles', root, query: atOpen.q, limit: 30 })
        .then((r: any) => ((r.files ?? []) as string[]).map((f) => (i === 0 ? f : joinPath(root, f))))
        .catch(() => [] as string[])))
        .then((lists) => { if (live) { setAtFiles(lists.flat().slice(0, 30)); setAtIdx(0); } });
    }, 80);
    return () => { live = false; clearTimeout(t); };
  }, [atOpen?.start, atOpen?.q, atRoots.join('\u0000')]);
  const pickFile = (file: string) => {
    if (!atOpen) return;
    const r = pickAt(text, atOpen, file);
    onChange(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(r.caret, r.caret); } });
  };

  const busy = !welcome && !!active && (active.state === 'running' || active.state === 'waiting' || active.state === 'starting');
  const canSend = (text.trim().length > 0 || imgs.length > 0 || atts.length > 0 || bundles.length > 0 || files.length > 0 || refs.length > 0 || recordings.length > 0) && !starting && !upload && !disabled;
  // a permission / question / plan card docked above the box (redesign phase 5): words typed here are its 拒绝理由 /
  // 修改意见 — sending them denies with them (the old card's reason field, same response); an empty Enter presses the
  // card's main button (允许一次 ↵). What exactly Enter does is `dockAction` (review I3: not in a card's first 600 ms,
  // not on key repeat, words from before the card are queued as before, slash commands are sent, a plan wants
  // Ctrl+Enter). Attachments without words are still an ordinary message (queued, never an approval).
  // the question card is in the conversation (stage C1), the others dock; the box keys behave the same for both
  const { dock: dockReq, ask: askReq } = splitPending(active?.pending ?? NO_PENDING_LOCAL);
  const docked = !welcome && !disabled && active ? dockReq ?? askReq : undefined;
  const dockAgent = agentWord(active?.info);
  const hasAttachments = imgs.length > 0 || atts.length > 0 || bundles.length > 0 || files.length > 0 || refs.length > 0 || recordings.length > 0;
  // 插话 takes words only (what the button always sent); attachments and slash commands wait their turn in the queue
  const canSteer = busy && !docked && !!active && canSend && !!text.trim() && !hasAttachments && !isSlashCommand(text);
  const steerNow = () => {
    if (!active) return;
    const t = text;
    setText('');
    setDraft(active.sessionId, '');
    void send(active.sessionId, t, undefined, true).catch((e) => toast(e.message));
  };
  // 下一句提示 (phase 2 spec §2): the engine's guess, grey in the empty box; Tab takes it, Esc / typing puts it away
  const suggestionRaw = useStore((s) => (active ? s.open[active.sessionId]?.conv.suggestion : undefined));
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const suggestion = !welcome && !disabled && !docked && !busy && !text && !hasAttachments && suggestionRaw && suggestionRaw !== dismissed ? suggestionRaw : undefined;
  const takeSuggestion = () => { if (!suggestion) return; onChange(suggestion); requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(suggestion.length, suggestion.length); } }); };
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
  const autoOver = usePageOpen();
  // the 接一个模型 dialog is a dialog too: an Enter meant for it must not answer a docked card underneath
  const dlgOpen = useDialogStore((s) => s.queue.length > 0);
  const connectOpen = useConnect((s) => !!s.req);
  const addOpen = useAddSource((s) => s.open);
  const dialogOpen = dlgOpen || connectOpen || addOpen;
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
  // the question card is in the conversation: it shows (and announces) this note itself (C-U2)
  const askNoteKey = docked && !dockReq && askReq ? primaryKey(dockScope, askReq.requestId) : null;
  useEffect(() => {
    if (!askNoteKey) return;
    setAskNote(askNoteKey, dockNote);
    return () => setAskNote(askNoteKey, undefined);
  }, [askNoteKey, dockNote]);

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
      if (!welcome && active?.sessionId === d.id) { d.reason = tr('不能引用这个对话自己'); return; }
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
  // 右键 → 引用到输入框 (quote.ts): the same composer as for REFERENCE_EVENT above takes the selection as `> …`
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<QuoteDetail>).detail;
      if (d.handled || !pane || disabled) return;
      const g = activeGroup(useStore.getState().layout);
      const p = g.panes[pane.paneId];
      if (g.focusedPaneId !== pane.paneId || !p || (p.activeTileId ?? p.tiles[0]?.id) !== pane.tileId) return;
      d.handled = true;
      onChangeRef.current((d.plain ? withLine : withQuote)(textRef.current, d.text));
      requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener(QUOTE_EVENT, on);
    return () => window.removeEventListener(QUOTE_EVENT, on);
  }, [pane?.paneId, pane?.tileId, disabled]);

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
    if (!q) { toast(tr('那段话已经发出去了')); return; }
    void useStore.getState().respondPermission(docked.requestId, denyResponse(docked, q.text));
  };

  /** a phone: a tick under the finger as a message leaves the box (UI refresh §8 触感) */
  const sendTick = () => { if (useStore.getState().mobile) haptic('tap'); };

  // 录屏: this box's own recordings (the welcome page's are 'welcome'); the built-in browser's go elsewhere
  const recTarget = welcome ? 'welcome' : active?.sessionId ?? '';
  useEffect(() => onRecorded((r) => {
    if (r.target !== recTarget) return;
    setRecordings((cur) => [...cur, r]);
    extractKeyframes(r.blob, r.ms).then((fs) => setRecordings((cur) => withFrames(cur, r.id, fs)), () => setRecordings((cur) => withFrames(cur, r.id, null)));
  }), [recTarget]);
  /** each recording: the video uploaded into the conversation's folder, its keyframes as pictures, a line saying so */
  const sendRecordings = async (sid: string, recs: ComposerRecording[]) => {
    const images: { mediaType: string; data: string }[] = [];
    const refs2: AttachmentRef[] = [];
    const lines: string[] = [];
    let failedFrames = false;
    for (const r of recs) {
      const up = await uploadAttachment(sid, r.blob, `recordings/rec-${r.start}.${r.ext}`);
      refs2.push({ kind: 'file', name: tr('录屏 {d}.{ext}', { d: fmtDuration(r.ms), ext: r.ext }), path: up.path, size: up.size });
      // the frames shown under the chip (the user may have removed some); still being taken: take them now
      let frames: { mediaType: string; data: string }[] = [];
      const st = framesState(r);
      if (st === 'ready') frames = r.frames!;
      else if (st === 'pending') { try { frames = await extractKeyframes(r.blob, r.ms); } catch { failedFrames = true; } }
      else failedFrames = true;
      lines.push(frames.length ? tr('（附了一段录屏，视频在 {path}；下面的图片是从里面挑的关键帧）', { path: up.path }) : tr('（附了一段录屏，视频在 {path}）', { path: up.path }));
      images.push(...frames);
    }
    if (failedFrames) toast(tr('没能从录屏里取出图片，只发了视频的位置'));
    return { images, atts: refs2, prefix: lines.join('\n') };
  };
  const withPrefix = (prefix: string, body: string) => (prefix ? (body ? `${prefix}\n${body}` : prefix) : body);

  const doSend = async () => {
    if (!canSend) return;
    const act = docked ? dockAction(docked, { text, attachments: hasAttachments, seen: seenRef.current, now: Date.now() }) : 'send';
    if (act === 'deny') { denyDocked(); return; }
    if (act === 'blocked') { toast(DOCK_BLOCKED); return; }
    if (act !== 'send') return;
    // 旁聊: /btw opens the side chat over this conversation (and asks, if there is a question) — nothing is sent
    const btw = parseBtw(text);
    if (btw !== null && active && !welcome) { openSideChat(active.sessionId, btw || undefined); setText(''); setDraft(active.sessionId, ''); return; }
    // words from before the card go out as an ordinary (queued) message; the card then offers to take them back
    const requeue = !!docked && !!seenRef.current?.carried && !hasAttachments && !imgs.length && !isSlashCommand(text);
    const t = text;
    if (/^\/goal\s+\S/.test(t.trim())) {
      // the text stays: the user may still want to send it as a plain message, or copy it over there
      if (remote) { toast(REMOTE_GOAL); return; }
      const objective = t.trim().replace(/^\/goal\s+/, '');
      const cwdFor = welcome ? cwd.trim() : active?.cwd ?? '';
      if (!cwdFor) { toast(tr('先选一个项目文件夹')); return; }
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
        toast(started?.sessionId ? tr('目标已创建，在新对话里运行') : tr('目标已创建并启动，进度在「目标」里'), true);
      } catch (e: any) { toast(e.message); }
      return;
    }
    const im = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
    if (welcome) {
      if (!cwd.trim()) return toast(tr('请先选择项目文件夹'));
      if (wPeer) return void startOnPeer();
      if (wWsl) return void startOnWsl();
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
      sendTick();
      setStarting(true);
      try {
        localStorage.setItem('cw.lastCwd', cwd);
        localStorage.setItem('cw.lastModel', model ?? '');
        localStorage.setItem('cw.lastMode', wMode);
        localStorage.setItem('cw.lastProvider', providerId);
        localStorage.setItem('cw.lastAgent', wAgent);
        if (wAgent !== 'claude' && !agent) throw new Error(tr('选中的 agent 已不可用'));
        const id = await openSession({ cwd: cwd.trim(), model, permissionMode: wMode, effort, ultracode: wUltracode && wUltra ? true : undefined, subagentModel: foreign ? undefined : wSubModel, worktree: wWorktree || undefined, providerId, features: foreign ? {} : wChatOnly ? { chatOnly: true } : featDefaults, agent: foreign ? wAgent : undefined }, target);
        setWChatOnly(false);
        // what is asked for anew for every conversation (操控电脑) is off again for the next one
        if (!foreign && isFeatures(storedFeatures) && afterStart(storedFeatures) !== storedFeatures) setFeatures(afterStart(storedFeatures));
        const uploaded = files.length ? await uploadAll(id) : [];
        const recs = recordings;
        const rec = recs.length ? await sendRecordings(id, recs) : { images: [], atts: [], prefix: '' };
        setRecordings([]);
        await send(id, withPrefix(rec.prefix, withRefs(t)), [...im, ...rec.images], false, [...atts, ...uploaded, ...rec.atts]);
        setRefs([]);
        setWSub(null); // a pick here is for that conversation; the next one starts on the default again
        saveDraft('welcome', '');
      } catch (e: any) {
        toast(e.message);
      }
      setStarting(false);
      setUpload(null);
      return;
    }
    if (!active) return;
    sendTick();
    setText('');
    // the box is empty now: what comes next is typed with the card in view — and its first moments start again, so
    // an Enter right after this one (a double press) does not answer the card (review M-3)
    if (docked && seenRef.current) setSeen({ carried: false, shownAt: Date.now() });
    setImgs([]);
    setAtts([]);
    setBundles([]);
    setRefs([]);
    setRecordings([]);
    setDraft(active.sessionId, '');
    const sentImgs = imgs, sentAtts = atts, sentBundles = bundles, sentRefs = refs, sentRecs = recordings;
    const full = withRefs(t);
    // a 页面标注 goes as its picture (after the pasted ones) and its words as a text attachment
    const parts = bundles.map(bundleParts);
    let uploaded: AttachmentRef[];
    let rec: { images: { mediaType: string; data: string }[]; atts: AttachmentRef[]; prefix: string } = { images: [], atts: [], prefix: '' };
    try {
      uploaded = files.length ? await uploadAll(active.sessionId) : [];
      if (sentRecs.length) rec = await sendRecordings(active.sessionId, sentRecs);
    } catch (e: any) {
      // nothing was sent: put the message back instead of silently dropping what the user typed
      toast(e.message);
      setUpload(null);
      setText((cur) => cur || t);
      if (t) setDraft(active.sessionId, t);
      setImgs((cur) => (cur.length ? cur : sentImgs));
      setAtts((cur) => (cur.length ? cur : sentAtts));
      setBundles((cur) => (cur.length ? cur : sentBundles));
      setRefs((cur) => (cur.length ? cur : sentRefs));
      setRecordings((cur) => (cur.length ? cur : sentRecs));
      return;
    }
    try {
      setFiles([]);
      const sid = active.sessionId;
      const before = useStore.getState().open[sid]?.queue.length ?? 0;
      setModeNotice(null);
      await send(sid, withPrefix(rec.prefix, full), [...im, ...parts.map((p) => p.image), ...rec.images], false, [...atts, ...parts.map((p) => p.text), ...uploaded, ...rec.atts], { expectMode: shownMode.current });
      if (requeue && seenRef.current?.requestId === docked?.requestId) {
        const q = useStore.getState().open[sid]?.queue ?? [];
        const mine = q.length > before ? q[q.length - 1] : undefined;
        setSeen({ carried: false, queued: mine && mine.text === full ? { id: mine.id, text: mine.text } : undefined });
      }
    } catch (e: any) {
      if (e instanceof ModeChangedError) {
        // nothing was sent: the draft comes back, the chip already shows the real mode, and a line under the box says so
        setUpload(null);
        setModeNotice({ sid: active.sessionId, text: e.message });
        setText((cur) => cur || t);
        if (t) setDraft(active.sessionId, t);
        setImgs((cur) => (cur.length ? cur : sentImgs));
        setAtts((cur) => (cur.length ? cur : sentAtts));
        setRefs((cur) => (cur.length ? cur : sentRefs));
        setRecordings((cur) => (cur.length ? cur : sentRecs));
        setBundles((cur) => (cur.length ? cur : sentBundles));
        return;
      }
      toast(e.message);
      setUpload(null);
      // a 页面标注 that did not go is not lost: back in the box (its picture exists nowhere else)
      setBundles((cur) => (cur.length ? cur : sentBundles));
    }
  };

  const pickCmd = (name: string) => {
    setText(`/${name} `);
    ta.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestion && !imeComposing(e.nativeEvent)) {
      // Tab or → (the official keys); → only does it while the box is empty, which is when the suggestion shows
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); takeSuggestion(); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(suggestion); return; }
    }
    if (e.key === 'Tab' && e.shiftKey && !text && !imeComposing(e.nativeEvent) && permCycle.current) { e.preventDefault(); permCycle.current(); return; }
    // Ctrl+U: 添加文件或图片, the official key (the + menu's first row)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyU' && !remote && !disabled) { e.preventDefault(); fileInput.current?.click(); return; }
    if (atOpen && atFiles.length && !imeComposing(e.nativeEvent)) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtIdx((i) => (i + 1) % atFiles.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAtIdx((i) => (i - 1 + atFiles.length) % atFiles.length); return; }
      // Enter picks only once something was typed after @ (a lone @ then Enter is a message); Tab always picks
      // Enter takes a file only when it really is what was typed (its path has the letters together) or one was picked
      // with the arrows — `ping @team` + Enter sends, it does not become a file that happens to have t-e-a-m in order
      const pick = atFiles[Math.min(atIdx, atFiles.length - 1)];
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && atOpen.q && (atIdx > 0 || pick.toLowerCase().includes(atOpen.q.toLowerCase())))) { e.preventDefault(); pickFile(pick); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAtClosed(atOpen.start); return; }
    }
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
      // Ctrl+Enter while a turn runs: 插话 (the official app's second key; Enter keeps queueing — the docked cards build on it)
      if ((e.ctrlKey || e.metaKey) && canSteer) { steerNow(); return; }
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
      toast(tr('长文本已作为附件（{tCount} 字符）', { tCount: t.length }), true);
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
    if (folders.length) toast(tr('已附加文件夹 {folders}（{restCount} 个文件{v}）', { folders: folders.join(', '), restCount: rest.length, v: truncated ? tr('，已截断到 500') : '' }), true);
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
    if (!picked.length) { toast(tr('文件夹 {top} 里只有依赖 / 构建产物 / .git，没有可附加的文件', { top })); return; }
    setFiles((s) => [...s, ...picked].slice(0, 500));
    toast(tr('已附加文件夹 {top}（{pickedCount} 个文件{v}{v2}）', { top, pickedCount: picked.length, v: truncated ? tr('，已截断到 500') : '', v2: skipped ? tr('，跳过 node_modules / .git 等 {skipped} 个', { skipped }) : '' }), true);
  };

  // 新对话选机器: a conversation on another computer starts there with that computer's own model and settings — this
  // one's providers / models / capabilities mean nothing there. Files on this disk cannot go (images can).
  const pickMachine = (v: string) => {
    setWMachine(v);
    const m = machineOf(v);
    if (m.kind === 'wsl') {
      // its own folders: the ones its conversations used, else its home as Windows reaches it
      const home = wslOf(m.distro)?.home;
      setCwd(wslDirs(m.distro)[0] ?? (home ? wslToWin(home, m.distro) : ''));
      return;
    }
    const id = m.kind === 'peer' ? m.id : '';
    const mine = sessions.filter((s) => (id ? s.peer?.id === id : !s.peer)).map((s) => s.cwd).filter(Boolean);
    setCwd(id ? mine[0] ?? '' : initialCwd({ stored: localStorage.getItem('cw.lastCwd'), sessions, workspaces, meta: sessionMeta }));
  };
  const wslDirs = (d: string) => [...new Set(sessions.filter((s) => { const e = sessionMeta[s.sessionId]?.env; return e?.kind === 'wsl' && e.distro === d; }).map((s) => s.cwd).filter(Boolean))].slice(0, 8);
  // a WSL conversation: the distro's own claude and login — no provider, no files from this disk (images can go)
  const startOnWsl = async () => {
    if (wslOf(wWsl)?.claude === false) { toast(tr('{d} 里没装 Claude Code：在选机器菜单里点「在 WSL 里安装」', { d: wWsl })); return; }
    if (files.length || atts.length) { toast(REMOTE_ATTACH); return; }
    const t = text.trim();
    if (!t && !imgs.length) return;
    sendTick();
    setStarting(true);
    try {
      const id = await openSession({ cwd: cwd.trim(), env: { kind: 'wsl', distro: wWsl }, permissionMode: wMode, worktree: wWorktree || undefined }, target);
      await send(id, withRefs(t), imgs.map(({ mediaType, data }) => ({ mediaType, data })), false, []);
      setRefs([]);
      saveDraft('welcome', '');
    } catch (e: any) {
      toast(String(e?.message ?? e));
    }
    setStarting(false);
  };
  const startOnPeer = async () => {
    if (files.length || atts.length) { toast(REMOTE_ATTACH); return; }
    const t = text.trim();
    if (!t && !imgs.length) return;
    sendTick();
    setStarting(true);
    try {
      const id = await openSession({ peer: wPeer, cwd: cwd.trim(), permissionMode: wMode, worktree: wWorktree || undefined }, target);
      await send(id, withRefs(t), imgs.map(({ mediaType, data }) => ({ mediaType, data })), false, []);
      setRefs([]);
      saveDraft('welcome', '');
    } catch (e: any) {
      toast(String(e?.message ?? e));
    }
    setStarting(false);
  };
  const pickDir = async () => {
    const p = await pickFolder({ start: cwd || undefined }).catch((e) => { toast((e as Error).message); return null; });
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
  // a conversation not running yet has no info: its agent comes from the list — except one that goes on in Claude
  // (DeepSeek Harness): its chips are Claude's, on what a new conversation would use until one is picked
  const listed = sessions.find((s) => s.sessionId === active?.sessionId);
  const inClaude = !info && !!listed?.caps?.continueInClaude;
  const sessionAgent: AgentKind = info?.agent ?? (inClaude ? 'claude' : listed?.agent) ?? 'claude';
  // the permission chip of a conversation that is not running: ask the server what the next send will really run in
  // (its record, else 新对话默认权限 — on the machine the conversation is on), again whenever this window's copy of the
  // record or the default changes; the chip shows that over the window's own guess (2026-10-26 QA)
  const resumeSid = !welcome && active && !liveOk && !inClaude ? active.sessionId : undefined;
  const serverMode = useStore((s) => (resumeSid ? s.resumeModes[resumeSid] : undefined));
  const loadResumeMode = useStore((s) => s.loadResumeMode);
  const copiedMode = resumeSid ? sessionMeta[resumeSid]?.permissionMode : undefined;
  useEffect(() => { if (resumeSid) void loadResumeMode(resumeSid); }, [resumeSid, active?.state, copiedMode, defaultMode, loadResumeMode]);
  const liveProvider = info?.providerId && info.providerId !== 'claude' ? info.providerId : 'claude';
  // a conversation already going with nothing to send on (spec 2026-10-26 §2.4): the Claude account logged out, or
  // its profile deleted since — the 添加来源 line shows over the box (on this machine's Claude conversations only)
  const convProvider = info?.providerId ?? (active ? sessionMeta[active.sessionId]?.providerId : undefined) ?? 'claude';
  // the status strip's 「not logged in」 chip already offers 添加来源 (and resends): then only it shows
  const stripAsks = useStore((s) => (active ? noLoginChipShown(s.open[active.sessionId]) : false));
  const liveNoSource = !welcome && !!active && !remote && !disabled && sessionAgent === 'claude' && !stripAsks
    && (convProvider === 'claude' ? needsModel({ provider: 'claude', foreignAgent: false, loggedIn }) : providers.length > 0 && !providers.some((p) => p.id === convProvider)); // (an empty list may just not be loaded yet)
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
    if (act.confirm && !(await dlg.confirm(tr('切换供应商？'), { message: tr('对话正在运行，当前这一轮会被中断。换供应商会重启对话进程，历史保留。'), okLabel: tr('切换') }))) return false;
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
  // 子代理: the conversation's own from now on; a running one restarts its process invisibly (after the turn, mid-turn)
  const pickSubagent = async (model: string, providerId: string, builtin: { value: string; displayName: string }[] | undefined, live: boolean) => {
    if (!active) return;
    try {
      await setSubagentModel(active.sessionId, model, providerId);
      const name = model ? subagentLabel({ providers, providerId, model, builtin }) : '';
      toast(model ? tr('子代理改用 {name}{v}', { name, v: live && busy ? tr('（这一轮结束后生效）') : '' }) : tr('子代理改回跟主模型一样{v}', { v: live && busy ? tr('（这一轮结束后生效）') : '' }), true);
    } catch (e: any) { toast(e.message); }
  };
  const setEffort = (effort: EffortLevel) => active && ws.request({ kind: 'session.setEffort', sessionId: active.sessionId, effort }).catch((e) => toast(e.message));
  const setUltracode = (on: boolean) => active && ws.request({ kind: 'session.setUltracode', sessionId: active.sessionId, on }).catch((e) => toast(e.message));

  // the other agents as sources in the model menu (Claude Code included when another agent is current)
  const otherAgents = useMemo<AgentSource[]>(() => {
    const list: AgentSource[] = agents.filter((a) => a.enabled !== false).map((a) => {
      // Claude's is the new-conversation default (settings → 供应商), the others' their own 「新对话用」
      const pid = a.kind === 'claude' ? (settings.defaultProviderId as string | undefined) : a.providerId;
      const via = usableProfile(providers, pid, { agent: a.kind, engine, gatewayGroups: gatewayView.groups, gatewayEnabled: gatewayView.enabled });
      return { kind: a.kind, name: a.name, installed: a.installed !== false, models: a.models, reportedModels: a.reportedModels, defaultModel: a.model || undefined, ...(via ? { provider: via } : {}) };
    });
    if (!list.some((a) => a.kind === 'claude')) list.unshift({ kind: 'claude', name: 'Claude Code', installed: true });
    return list;
  }, [agents, providers, engine, gatewayView.groups, gatewayView.enabled, settings.defaultProviderId]);

  // another computer's folders: the ones its conversations ran in (this computer's dialog cannot browse there)
  const recentDirs = useMemo(() => (wWsl ? wslDirs(wWsl) : [...new Set(sessions.filter((s) => (wPeer ? s.peer?.id === wPeer : !s.peer) && sessionMeta[s.sessionId]?.env?.kind !== 'wsl').map((s) => s.cwd).filter(Boolean))].slice(0, 8)), [sessions, wPeer, wWsl, sessionMeta]);
  const folderChips = useMemo(() => { const m = new Map<string, number>(); for (const f of files) { const top = f.rel.includes('/') ? f.rel.split('/')[0] : null; if (top) m.set(top, (m.get(top) ?? 0) + 1); } return m; }, [files]);

  // the capabilities: on the welcome page the ones the new conversation will get (removable); in a running one
  // what it was started with (fixed — a launch parameter)
  const claudeHere = welcome ? !foreign : sessionAgent === 'claude';
  const sessionFeatures = info?.features ?? NO_FEATURES;
  const tags = welcome ? (claudeHere && !wChatOnly ? capabilityTags(featDefaults, capEnv) : []) : capabilityTags(sessionFeatures, capEnv);
  const hasChips = imgs.length > 0 || atts.length > 0 || bundles.length > 0 || files.length > 0 || refs.length > 0 || recordings.length > 0 || !!upload || tags.length > 0 || (welcome && (!!wWorktree || wChatOnly)) || (!welcome && liveChatOnly);
  const insertSlash = () => { const v = text.startsWith('/') ? text : `/${text}`; onChange(v); requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(1, 1); } }); };
  const insertGoal = () => { const v = text.trim() ? `/goal ${text.trim()}` : '/goal '; onChange(v); requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }); };

  // ---- the row's pieces
  const plus = (
    <PlusMenu claude={claudeHere} live={!welcome} remote={remote} disabled={disabled} plain={bot}
      features={welcome ? featDefaults : sessionFeatures} onFeatures={setFeatures} selfId={welcome ? undefined : active?.sessionId}
      chatOnly={welcome ? wChatOnly : undefined} onChatOnly={welcome && claudeHere && !wPeer && !wWsl ? setWChatOnly : undefined}
      onFiles={() => fileInput.current?.click()} onFolder={() => folderInput.current?.click()} onReference={addRef} onGoal={insertGoal} onSlash={insertSlash} onRecord={desktop?.captureSources && !remote ? () => openPicker(recTarget) : undefined} sessionId={!welcome && claudeHere ? active?.sessionId : undefined} />
  );
  // one round button that changes in place (UI refresh §6 「发送键」): faint with nothing to send, ink with something,
  // the stop square while a turn is in flight. Both glyphs are always there and cross-fade on `data-state`
  // (styles/composer.css); `.send.stop`, the labels and the titles are what they were as two buttons
  const face = sendFace({ busy, canSend, working: starting || !!upload });
  const send_ = (
    <button type="button" className={clsx('send', busy && 'stop')} data-id={BAR_ID.send} data-state={face} disabled={!busy && !canSend}
      onClick={busy ? () => { if (active) void interrupt(active.sessionId); } : () => void doSend()} title={busy ? tr('中断 (Esc)') : tr('发送 (Enter)')} aria-label={busy ? tr('中断') : tr('发送')}>
      <span className="send-ic up" aria-hidden><Icon name="send" size={18} /></span>
      <span className="send-ic sq" aria-hidden />
      {face === 'working' && <ProcessGlyph process="start" className="send-glyph" />}
    </button>
  );
  const steer = docked && (dockClick === 'deny' || dockClick === 'blocked') ? (
    <button className="steer deny" data-id={BAR_ID.steer} disabled={dockClick === 'blocked'} title={dockClick === 'blocked' ? DOCK_BLOCKED : tr('拒绝这次请求，并把这段话告诉 {dockAgent}（Enter）', { dockAgent })} onClick={denyDocked}>{DOCK_SEND[dockKind(docked)]} <Icon name="send" size={12} /></button>
  ) : busy && canSend && active ? (
    <button className="steer" data-id={BAR_ID.steer} title={tr('{steer}：不等这一轮结束，马上把这句话告诉 Claude（Ctrl+Enter）', { steer: TERMS.steer })} aria-label={TERMS.steer} onClick={steerNow}>{tr('插话')} <Icon name="send" size={12} /></button>
  ) : null;
  const mic = speechOk && !mobile ? (
    <button data-id={BAR_ID.mic} className={clsx('icon-btn', listening && 'active')} title={listening ? tr('停止语音输入') : tr('语音输入（浏览器识别）')} onClick={toggleVoice} aria-label={tr('语音输入')}><Icon name="mic" size={15} /></button>
  ) : null;

  let model: React.ReactNode = null, subagent: React.ReactNode = null, effort: React.ReactNode = null, permission: React.ReactNode = null, meter: React.ReactNode = null, status: React.ReactNode = null;
  shownMode.current = undefined;
  // Shift+Tab steps only the permission chip drawn below — none drawn (a conversation starting), nothing to step
  permCycle.current = null;
  // 深度编排 on: the placeholder says what to ask for (user report: the switch looked clear, but not how to use it)
  let ultraOn = false;
  if (welcome) {
    const t = modelChipText({ agent: wKind, agentName: agent?.name, providers, providerId: provider?.id, model: wModel, builtin: wBuiltin, agentDefault: agent?.model || undefined, efforts: wEfforts, effort: wEffortOk, defaultEffort: wView.defaultLevel, ultracode: wUltracode && wUltra, accountDefault });
    model = (
      <ModelChip
        agent={wKind}
        current={{ providerId: provider ? provider.id : 'claude', model: wModel }}
        label={t.main}
        title={tr("{main}{v}\n用哪个模型：Agent、供应商、模型都在这里", { main: t.main, v: t.isDefault ? tr('（默认）') : '' })}
        builtin={wBuiltin}
        builtinTitle={agent ? tr('{name} 账号', { name: agent.name }) : ownName}
        agentDefault={agent?.model || undefined}
        otherAgents={otherAgents}
        onPick={pickWelcome}
      />
    );
    // WSL: the distro's own Claude login — the model chip is locked to Claude
    if (wWsl) model = <button type="button" className="cchip" disabled title={tr('WSL 里的对话用发行版自己的 Claude 登录')}><span className="cchip-l">Claude</span></button>;
    if (!foreign && !wWsl) subagent = <SubagentChip providerId={wProviderId} value={wSubModel} onPick={(m) => setWSub({ providerId: wProviderId, model: m })} />;
    ultraOn = wUltracode && wUltra;
    effort = (
      <EffortChip
        compact={mobile}
        intelligence={{ levels: wEfforts, value: wEffortOk, defaultLevel: wView.defaultLevel, mode: wView.mode, onChange: (effort) => { const next = mergeResume({ effort: wEffort || undefined, ultracode: wUltra }, { effort }); setWEffort(effort); setWUltra(!!next.ultracode); } }}
        ultracode={wUltracode ? { on: wUltra, onChange: setWUltra } : undefined}
      />
    );
    permCycle.current = () => { modeTouched.current = true; setWMode(nextPermissionMode(wMode)); };
    permission = <PermissionChip mode={wMode} compact={mobile} onPick={(m) => { modeTouched.current = true; setWMode(m); }} />;
  } else if (liveOk) {
    const ultraOk = info.supportsUltracode !== false && !!CATALOG[liveAgent]?.supportsUltracode;
    const liveView = claudeEffortView({ agent: liveAgent, providers, providerId: remote ? 'claude' : liveProvider, model: info.model, runtime: info.runtime });
    const defaultEffort = liveView.defaultLevel;
    const t = modelChipText({ agent: liveAgent, agentName: info.agentName, providers, providerId: remote ? 'claude' : liveProvider, providerName: info.providerName, model: info.model, builtin: liveProvider === 'claude' && info.models?.length ? info.models : undefined, agentDefault: liveAgentDefault, efforts: liveEfforts, effort: info.effort, defaultEffort, ultracode: ultraOk && !!info.ultracode, accountDefault });
    const remoteLabel = `${info.providerName ? `${info.providerName} / ` : ''}${info.models?.find((m) => m.value === info.model)?.displayName ?? (shortModel(info.model) || tr('模型'))}`;
    // 智能路由: 「自动 → 实际：<model>」 — the real model is never hidden behind the strategy (spec §7.2)
    const pol = info.model ? policyOfModel(info.model) : undefined;
    const routedNote = pol && routed ? { label: tr('{policy} → 实际：{model}', { policy: routingPolicyLabel(pol), model: routed.model }), title: tr('智能路由实际用的是 {label}（{reason}）{switched}', { label: routed.label, reason: routed.reason, switched: routed.switched ? tr('，这次换过候选') : '' }) } : undefined;
    model = (
      <ModelChip
        agent={liveAgent}
        current={{ providerId: remote ? 'claude' : liveProvider, model: info.model }}
        label={routedNote ? routedNote.label : remote ? remoteLabel : t.main}
        title={(remote ? tr('模型（其它机器上的对话：换供应商请在那台机器上操作）') : tr("{main}{v}\n同一供应商直接换模型；换供应商会无感重启对话；选其它 Agent 的模型 = 交给它继续", { main: t.main, v: t.isDefault ? tr('（默认）') : '' })) + (routedNote ? '\n' + routedNote.title : '')}
        builtin={(remote || liveProvider === 'claude') && info.models?.length ? info.models : undefined}
        builtinTitle={remote ? info.providerName ?? info.agentName ?? tr('模型') : liveAgent === 'claude' ? ownName : tr('{agentName} 账号', { agentName: info.agentName ?? liveAgent })}
        agentDefault={liveAgentDefault}
        lockProvider={remote ? 'claude' : undefined}
        lockNote={tr('其它机器上的对话：只能换模型，换供应商请在那台机器上操作')}
        otherAgents={remote ? undefined : otherAgents}
        busy={swapping}
        disabled={swapping}
        onPick={pickLive}
      />
    );
    if (liveAgent === 'claude' && !remote) {
      const builtin = liveProvider === 'claude' && info.models?.length ? info.models : undefined;
      subagent = <SubagentChip providerId={liveProvider} value={info.subagentModel ?? ''} builtin={builtin} disabled={swapping} onPick={(m) => void pickSubagent(m, liveProvider, builtin, true)} />;
    }
    ultraOn = ultraOk && !!info.ultracode;
    effort = (
      <EffortChip
        compact={mobile}
        disabled={swapping}
        intelligence={{ levels: liveEfforts, value: info.effort, defaultLevel: defaultEffort, mode: liveModel?.effortMode ?? liveView.mode, onChange: setEffort }}
        ultracode={ultraOk ? { on: !!info.ultracode, onChange: setUltracode } : undefined}
      />
    );
    permCycle.current = () => setMode(nextPermissionMode(info.permissionMode ?? 'default'));
    permission = <PermissionChip mode={info.permissionMode ?? 'default'} compact={mobile} onPick={setMode} />;
  } else if (active && !disabled && active.state !== 'starting') {
    // not running (history, reaped, crashed — every conversation after a restart): the chips show what the next
    // send resumes it with, and a pick there changes that (final review §9 #1)
    const cont = inClaude ? sessionMeta[active.sessionId]?.continuedAs : undefined;
    const v = resumeView(active, !inClaude ? sessionMeta[active.sessionId] : cont ? sessionMeta[cont] ?? {} : { providerId: (settings.defaultProviderId as string | undefined) || 'claude' }, remote ? undefined : defaultMode, inClaude ? undefined : serverMode);
    const rAgent = sessionAgent;
    const rProvider = remote ? 'claude' : v.providerId;
    const rP = providers.find((p) => p.id === rProvider);
    const rView = claudeEffortView({ agent: rAgent, providers, providerId: rProvider, model: v.model, runtime: rP ? effectiveRuntime(rP, engine) : undefined });
    const rEfforts = rView.levels;
    const rUltraOk = !remote && rView.ultracode;
    const t = modelChipText({ agent: rAgent, agentName: agents.find((a) => a.kind === rAgent)?.name, providers, providerId: rProvider, model: v.model, agentDefault: resumeAgentDefault, efforts: rEfforts, effort: v.effort, defaultEffort: rView.defaultLevel, ultracode: rUltraOk && v.ultracode, accountDefault });
    const sid = active.sessionId;
    // nothing picked: the chip names the default the resume will really get; the transcript's last model is a hint
    const lastHint = !v.model && v.lastModel ? tr("\n上次回答用的是 {displayName}", { displayName: modelsFor(rAgent, [{ id: v.lastModel }])[0]?.displayName ?? v.lastModel }) : '';
    model = (
      <ModelChip
        agent={rAgent}
        current={{ providerId: rProvider, model: v.model }}
        label={t.main}
        title={tr("{main}{v}{lastHint}\n对话没在运行：发送后用这里选的模型继续{v2}", { main: t.main, v: t.isDefault ? tr('（默认）') : '', lastHint, v2: remote ? '' : tr('；选其它 Agent 的模型 = 交给它继续') })}
        builtinTitle={rAgent === 'claude' ? ownName : tr('{name} 账号', { name: agents.find((a) => a.kind === rAgent)?.name ?? rAgent })}
        agentDefault={resumeAgentDefault}
        lockProvider={remote ? 'claude' : undefined}
        lockNote={tr('其它机器上的对话：只能换模型，换供应商请在那台机器上操作')}
        otherAgents={remote ? undefined : otherAgents}
        busy={swapping}
        disabled={swapping}
        onPick={(it) => pickResume(it, v)}
      />
    );
    if (rAgent === 'claude' && !remote) subagent = <SubagentChip providerId={rProvider} value={subagentModelFor({ recorded: sessionMeta[sid]?.subagent, settings, providerId: rProvider })} disabled={swapping} onPick={(m) => void pickSubagent(m, rProvider, undefined, false)} />;
    ultraOn = rUltraOk && !!v.ultracode;
    effort = (
      <EffortChip
        compact={mobile}
        disabled={swapping}
        intelligence={{ levels: rEfforts, value: v.effort, defaultLevel: rView.defaultLevel, mode: rView.mode, onChange: (effort) => setResume(sid, { effort }) }}
        ultracode={rUltraOk ? { on: v.ultracode, onChange: (on) => setResume(sid, { ultracode: on }) } : undefined}
      />
    );
    permCycle.current = () => setResume(sid, { permissionMode: nextPermissionMode(v.permissionMode) });
    permission = <PermissionChip mode={v.permissionMode} compact={mobile} onPick={(m) => { setModeNotice(null); setResume(sid, { permissionMode: m }); }} />;
    shownMode.current = v.permissionMode;
    status = modeNotice?.sid === sid
      ? <span className="cb-status mode-notice" role="status">{modeNotice.text}</span>
      : <span className="cb-status opt" title={tr('对话没在运行，发送后按这里选的模型和权限继续')}>{tr('发送后继续')}</span>;
  } else if (active) {
    status = <span className="cb-status">{disabled ? tr('对话已删除') : tr('启动中…')}</span>;
  }
  // a bot's conversation: none of what it runs with is picked here (the 「发送后继续」 note speaks of those chips too)
  if (bot) {
    model = subagent = effort = permission = null;
    permCycle.current = null;
    shownMode.current = undefined;
    if (active && !liveOk && !disabled && active.state !== 'starting') status = null;
  }
  if (!welcome && active) meter = <ContextMeter sessionId={active.sessionId} />;
  // the model menu's last row opens the 子代理 menu (the chip is right there, but people look in the model menu)
  if (isValidElement<{ providerId: string; value: string; builtin?: { value: string; displayName: string }[] }>(subagent) && isValidElement(model)) {
    const sp = subagent.props;
    model = cloneElement(model as React.ReactElement<{ subagentRow?: { label: string; onOpen: () => void } }>, { subagentRow: { label: sp.value ? subagentLabel({ providers, providerId: sp.providerId, model: sp.value, builtin: sp.builtin }) : tr('跟主模型一样'), onOpen: () => setSubOpen((n) => n + 1) } });
    subagent = cloneElement(subagent as React.ReactElement<{ openSignal?: number }>, { openSignal: subOpen });
  }
  // and 强度 › / 快速模式 (phase 6 §4), as the official model menu has them
  if (isValidElement<EffortChipProps>(effort) && isValidElement(model)) {
    const ep = effort.props;
    const cur = ep.intelligence?.value ?? ep.intelligence?.defaultLevel;
    const label = ep.ultracode?.on ? ULTRACODE.label : cur ? EFFORT_LABEL[cur] : '';
    model = cloneElement(model as React.ReactElement<{ effortRow?: { label: string; onOpen: () => void } }>, { effortRow: { label, onOpen: () => setEffortOpen((n) => n + 1) } });
    effort = cloneElement(effort as React.ReactElement<EffortChipProps>, { openSignal: effortOpen });
  }
  if (liveOk && info.fastMode && liveAgent === 'claude' && isValidElement(model) && !FAST_NEVER.has(info.fastModeOff ?? '')) {
    const sid = active!.sessionId;
    const on = info.fastMode !== 'off';
    const note = info.fastMode === 'cooldown' ? tr('额度限速，稍后自动恢复') : info.fastModeOff ? fastOffText(info.fastModeOff) : undefined;
    model = cloneElement(model as React.ReactElement<{ fast?: { on: boolean; note?: string; onToggle: (on: boolean) => void } }>, {
      fast: { on, note, onToggle: (v) => void ws.request({ kind: 'session.fastMode', sessionId: sid, on: v }).catch((e) => toast(tr('快速模式没切换：{e}', { e: e.message }))) },
    });
  }

  // the light around the box while this conversation runs (the stop button also shows while it waits or starts)
  const glow = glowing({ welcome, state: active?.state, visible });
  // a conversation on a wide screen: the chips go on a line under the box (phase 6 §3); a phone keeps one row. The
  // new-conversation page too (the official one: computer · folder · permission under the box, the model on the right),
  // unless 设置 → 新对话页的输入框 puts them back in the box
  const welcomeUnder = welcome && !mobile && settings['ui.welcomeLayout'] !== 'inbox';
  const under = (!welcome && !mobile) || welcomeUnder;
  const projectChips = welcome ? <><MachineChip peers={peers} wsl={wslDistros} value={wMachine} onPick={pickMachine} onAddSsh={() => setAddSsh(true)} onInstall={(d) => void installWsl(d)} onOpen={loadWsl} hideWhenAlone={mobile} /><ProjectChip cwd={cwd} recent={recentDirs} onPick={setCwd} onBrowse={() => (wPeer ? toast(tr('别的电脑上的文件夹，从它最近用过的里面选')) : void pickDir())} worktree={wWorktree} onWorktree={setWWorktree} /></> : null;
  const branchChip = welcome && !mobile && !wPeer && !wWsl ? <BranchChip cwd={cwd} /> : null;
  // the official title bar's 💬 / </> switch: here it is 只聊天 (no tools) or not, for the conversation about to start
  const modeSwitch = welcomeUnder && claudeHere && !wPeer && !wWsl ? (
    <span className="seg cmp-mode" role="radiogroup" aria-label={tr('对话方式')}>
      <button role="radio" aria-checked={!wChatOnly} className={clsx(!wChatOnly && 'active')} data-mode="code" title={tr('Claude 可以读写文件、运行命令')} onClick={() => setWChatOnly(false)}><Icon name="code" size={13} /> {tr('代码')}</button>
      <button role="radio" aria-checked={wChatOnly} className={clsx(wChatOnly && 'active')} data-mode="chat" title={tr('只聊天：这个新对话不给 Claude 任何工具')} onClick={() => setWChatOnly(true)}><Icon name="chat" size={13} /> {tr('聊天')}</button>
    </span>
  ) : null;

  if (!welcome && active && handedOff) return <div className="composer"><div className="composer-inner"><HandedOffBar sessionId={active.sessionId} cwd={active.cwd} info={handedOff} /></div></div>;
  return (
    // data-paused: something lies over the conversation — the looping animations in here (the light, the tab's dot
    // and sweep) hold still until it is back in view (UI refresh §4.5)
    <div className="composer" data-paused={inView ? undefined : ''}>
      <div className="composer-inner">
        {atOpen && atFiles.length > 0 && (
          <div className="palette at-files" role="listbox" aria-label={tr('文件')}>
            {atFiles.map((f, i) => (
              <div key={f} role="option" aria-selected={i === atIdx} className={`it ${i === atIdx ? 'sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickFile(f); }}>
                <span className="n">{f.slice(f.lastIndexOf('/') + 1)}</span>
                <span className="d">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
              </div>
            ))}
          </div>
        )}
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
        {active && !welcome && <SideChat sessionId={active.sessionId} onDraft={(t) => { onChange(t); ta.current?.focus(); }} />}
        {active && !welcome && <StatusStrip sessionId={active.sessionId} />}
        {/* what was sent while the turn runs waits here, a card each; 编辑 puts one back into the box */}
        {active && !welcome && <QueueCards key={active.sessionId} sessionId={active.sessionId} queue={active.queue} onEdit={(t) => { setText((cur) => (cur ? `${cur}\n${t}` : t)); ta.current?.focus(); }} />}
        {/* 后台: a workflow / sub-agent / background command still going — the pill opens the 后台 page on it */}
        {active && !welcome && <BackgroundPill sessionId={active.sessionId} />}
        {/* a docked card takes the run card's place (spec §4.2: 「等确认时被权限卡替代」) */}
        {active && !welcome && (docked && dockReq
          ? <PermissionDock sessionId={active.sessionId} reason={text} onReasonUsed={() => onChange('')} scope={dockScope} note={dockNote} onDenyQueued={queuedOffer ? denyQueued : undefined} />
          : <RunCard sessionId={active.sessionId} />)}
        {/* nothing to send with (spec 2026-10-26 §2.4): 添加来源 opens over this conversation; the draft stays in the box and
            a source added there is picked up by welcomeProvider, so this line goes away by itself */}
        {welcome && needsModel({ provider: wProviderId, foreignAgent: foreign, loggedIn }) && (
          <div className="cmp-add-source" role="status">
            <span>{tr('还没有能用的模型来源。')}</span>
            <button type="button" className="link" onClick={() => openAddSource()}>{tr('添加来源')}</button>
          </div>
        )}
        {/* the same for a conversation already going: the wizard opens in place, the draft stays, and an API source added
            there becomes this conversation's (session.setProvider) */}
        {liveNoSource && active && (
          <div className="cmp-add-source" role="status" data-live="1">
            <span>{tr('这个对话没有能用的模型来源。')}</span>
            <button type="button" className="link" onClick={() => openAddSource(undefined, (p) => {
              if (p) void ws.request({ kind: 'session.setProvider', sessionId: active.sessionId, providerId: p.id }).catch((e) => toast(e.message));
            })}>{tr('添加来源')}</button>
          </div>
        )}
        <div className={clsx('composer-box', under && 'one-line')} data-state={face} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {glow && <span className="composer-glow" aria-hidden><i /></span>}
          {hasChips && (
            <div className="attach">
              {!welcome && liveChatOnly && (
                <span className="cap-tag fixed" data-cap="chatOnly" title={tr('这个对话开始时就是只聊天：Claude 没有任何工具')}><Icon name="chat" size={12} /> {tr('只聊天')}</span>
              )}
              {welcome && wChatOnly && (
                <span className="cap-tag" data-cap="chatOnly" title={tr('这个新对话不给 Claude 任何工具')}>
                  <Icon name="chat" size={12} /> {tr('只聊天')}
                  <button aria-label={tr('关闭{label}', { label: tr('只聊天') })} onClick={() => setWChatOnly(false)}><Icon name="close" size={10} /></button>
                </span>
              )}
              {tags.map((t) => (
                <span key={`t${t.key}`} className={clsx('cap-tag', !welcome && 'fixed')} data-cap={t.key} title={welcome ? t.title : tr("{title}\n这个对话开始时就开着", { title: t.title })}>
                  <Icon name={t.icon} size={12} /> {t.label}
                  {welcome && <button aria-label={tr('关闭{label}', { label: t.label })} onClick={() => setFeatures(withoutTag(featDefaults, t.key))}><Icon name="close" size={10} /></button>}
                </span>
              ))}
              {welcome && wWorktree && (
                <span className="cap-tag" data-cap="worktree" title={tr('新对话在项目的独立副本（git worktree「{wWorktree}」）里运行', { wWorktree })}>
                  <Icon name="branch" size={12} /> {tr('独立副本 · {wWorktree}', { wWorktree })}
                  <button aria-label={tr('不用独立副本')} onClick={() => setWWorktree('')}><Icon name="close" size={10} /></button>
                </span>
              )}
              {refs.map((r) => (
                <SessionRefChip key={`r${r.id}`} a={{ kind: 'session', name: r.title, sessionId: r.id }} onRemove={() => setRefs((s) => s.filter((x) => x.id !== r.id))} />
              ))}
              {/* click: the big viewer (wheel zoom, ← →); hover: the × that removes it (it used to remove on click) */}
              {imgs.map((im, i) => (
                <span key={i} className="att-img">
                  <button type="button" className="att-img-open" onClick={() => useStore.setState({ viewer: { images: imgs.map((x) => x.url), index: i } })} title={tr('{name} · 点击放大', { name: im.name ?? tr('图片') })} aria-label={tr('放大 {name}', { name: im.name ?? tr('图片') })}>
                    <img src={im.url} alt="" />
                  </button>
                  <button type="button" className="att-img-x" onClick={() => setImgs((s) => s.filter((_, j) => j !== i))} title={tr('移除')} aria-label={tr('移除 {name}', { name: im.name ?? tr('图片') })}><Icon name="close" size={10} /></button>
                </span>
              ))}
              {/* 页面标注: its picture and its words are one chip (the picture opens big; the words show on hover) */}
              {bundles.map((b) => (
                <span key={b.id} className="att-chip att-bundle" data-att="bundle" title={b.text.slice(0, 600)}>
                  <button type="button" className="att-bundle-img" onClick={() => useStore.setState({ viewer: { images: [b.image.url], index: 0 } })} aria-label={tr('放大 {name}', { name: b.name })}><img src={b.image.url} alt="" /></button>
                  {b.name}
                  <button aria-label={tr('移除 {name}', { name: b.name })} onClick={() => setBundles((s) => s.filter((x) => x.id !== b.id))}><Icon name="close" size={10} /></button>
                </span>
              ))}
              {atts.map((a, i) => (
                <span key={`a${i}`} className="att-chip" title={a.text?.slice(0, 300)}><Icon name="read" size={12} /> {a.name} <span className="sz">{fmtSize(a.size)}</span><button aria-label={tr('移除')} onClick={() => setAtts((s) => s.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button></span>
              ))}
              {[...folderChips].map(([name, n]) => (
                <span key={`d${name}`} className="att-chip" title={tr('{n} 个文件', { n })}><Icon name="folder" size={12} /> {name} <span className="sz">{tr('{n} 文件', { n })}</span><button aria-label={tr('移除')} onClick={() => setFiles((s) => s.filter((f) => !f.rel.startsWith(name + '/')))}><Icon name="close" size={10} /></button></span>
              ))}
              {files.filter((f) => !f.rel.includes('/')).map((f, i) => (
                <span key={`f${i}`} className="att-chip" title={f.file.name}><Icon name="attach" size={12} /> {f.file.name} <span className="sz">{fmtSize(f.file.size)}</span><button aria-label={tr('移除')} onClick={() => setFiles((s) => s.filter((x) => x !== f))}><Icon name="close" size={10} /></button></span>
              ))}
              {recordings.map((r) => (
                <span key={r.id} className="att-rec-wrap">
                  <span className="att-chip att-rec" data-att="recording"><Icon name="monitor" size={12} /> {tr('录屏 · {d}', { d: fmtDuration(r.ms) })} <span className="sz">{fmtSize(r.blob.size)}</span><button aria-label={tr('移除')} onClick={() => setRecordings((s) => s.filter((x) => x.id !== r.id))}><Icon name="close" size={10} /></button></span>
                  {framesState(r) === 'pending' && <span className="att-rec-note"><span className="spinner" /> {tr('正在取关键帧…')}</span>}
                  {r.frames && r.frames.length > 0 && (
                    <span className="att-rec-frames" role="list" aria-label={tr('随录屏发送的关键帧')}>
                      {r.frames.map((f, i) => (
                        <span key={i} className="att-rec-frame" role="listitem">
                          <img src={`data:${f.mediaType};base64,${f.data}`} alt={tr('关键帧 {n}', { n: i + 1 })} />
                          <button aria-label={tr('去掉这张关键帧')} onClick={() => setRecordings((s) => withoutFrame(s, r.id, i))}><Icon name="close" size={10} /></button>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              ))}
              {upload && <span className="att-chip"><span className="spinner" /> {tr('上传 {done}/{total} · {name}', { done: upload.done + 1, total: upload.total, name: upload.name })}</span>}
            </div>
          )}
          {suggestion && mobile && <button className="cmp-suggest" onClick={takeSuggestion}><Icon name="sparkle" size={12} /> {tr('用这句')}</button>}
          <textarea
            ref={ta}
            data-suggestion={suggestion ? '' : undefined}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={suggestion ? `${suggestion}   ${tr('Tab 采用')}` : disabled ? tr('对话已被删除，不能继续') : docked ? dockPlaceholder(docked, dockAgent) : welcome && !ultraOn ? tr('描述一个任务，或者问个问题。输入 / 查看命令，拖入文件作为附件') : busy ? tr('Enter 排到这一轮之后，Ctrl+Enter 马上插话 · Esc 中断') : ultraOn ? ULTRACODE.placeholder : active?.state === 'history' ? tr('发送即可继续这个对话…') : tr('回复 {agentName}… 输入 / 查看命令，拖入文件作为附件', { agentName: info?.agentName && info.agent !== 'claude' ? info.agentName : 'Claude' })}
            onChange={(e) => { setCaret(e.target.selectionStart ?? e.target.value.length); onChange(e.target.value); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKey}
            onPaste={onPaste}
            // a phone's soft keyboard labels its return key 发送: Enter sends here (Shift+Enter is a new line)
            enterKeyHint={mobile ? 'send' : undefined}
          />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const fl = Array.from(e.target.files ?? []); void addImages(fl.filter((f) => f.type.startsWith('image/'))); if (remote && fl.some((f) => !f.type.startsWith('image/'))) { toast(REMOTE_ATTACH); e.target.value = ''; return; } setFiles((s) => [...s, ...fl.filter((f) => !f.type.startsWith('image/')).map((f) => ({ file: f, rel: f.name }))]); e.target.value = ''; }} />
          <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(e) => { onFolderPicked(e.target.files); e.target.value = ''; }} />
          <ComposerBar
            plus={plus}
            project={welcomeUnder ? null : projectChips}
            branch={welcomeUnder ? null : branchChip}
            status={under ? undefined : status}
            meter={under ? undefined : meter}
            model={under ? undefined : model}
            subagent={under ? undefined : subagent}
            effort={under ? undefined : effort}
            permission={under ? undefined : permission}
            mic={mic}
            steer={steer}
            send={send_}
          />
        </div>
        {!welcome && active?.info?.wsl && active.info.wsl.dropped.length > 0 && <div className="sub cmp-wsl-note">{tr('Windows 互通已关：记忆、联网、操控电脑在这个对话里不可用')}</div>}
        {under && <ComposerUnder lead={welcomeUnder ? <>{modeSwitch}{projectChips}{branchChip}</> : undefined} permission={permission} stats={!welcome && active ? <ConvStatsLine sessionId={active.sessionId} /> : undefined} status={status} model={model} subagent={subagent} effort={effort} meter={meter} />}
      </div>
      {addSsh && <Suspense fallback={null}><AddSshDialog onClose={() => setAddSsh(false)} onJoined={(id) => { ws.request<PeerInfo[]>({ kind: 'peers.list' }).then((l) => setPeers(Array.isArray(l) ? l : [])).catch(() => {}); pickMachine(id); }} /></Suspense>}
    </div>
  );
}
