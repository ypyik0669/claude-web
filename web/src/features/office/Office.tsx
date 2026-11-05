// 后台 · 网吧: the 3D internet cafe of every conversation's background (scene.ts draws it) and the HTML around it —
// the count pill, the zones / waiting / finished / activity panel, a person's or a zone's card, the breadcrumb, zoom
// and day / night. Loaded with lazy() (three.js stays out of the first screen). Without WebGL it is a plain list.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { resolveCharacter, type CharacterDef } from '@characters';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { wheelZoom } from '@/ui/wheel-zoom';
import { imeComposing } from '@/ui/ime';
import { clsx } from '@/util';
import { useBackground, stopTask } from '@/features/background/state';
import { agentColor, clock, tokensText } from '@/features/background/model';
import { hhmm } from '@/features/background/EventFeed';
import { useCafe, openLibrary } from '@/features/cafe/state';
import { bakeCharacter } from '@/features/cafe/bake';
import { officeModel, roomsFor, seatBots, seatRooms, statusWord, type BotStatus, type OfficeBot, type OfficeZone, type OfficeModel } from './model';
import { usd } from '@/features/cafe/money';
import { agentHex, CafeScene, webglOk, type SceneZone } from './scene';
import { tr } from '@/i18n';

export interface OfficeProps {
  /** the right panel's small cafe: no side panel, starts on `follow`'s zone */
  compact?: boolean;
  /** a conversation picked elsewhere (the page's sidebar, the active one): its zone comes into view */
  follow?: string;
  /** a zone was picked here */
  onFloor?: (sessionId: string) => void;
  /** a bot's own conversation */
  onOpenAgent: (sessionId: string, taskId: string, agentKey: string) => void;
  /** the conversation itself (the lead) */
  onOpenChat: (sessionId: string) => void;
}

const zoneName = (f: { letter: string }) => tr('{z}区', { z: f.letter });
const DOT: Record<BotStatus, string> = { working: 'var(--green)', waiting: 'var(--yellow)', stuck: 'var(--red)', resting: 'var(--ink-4)', finished: 'var(--accent-text)' };

function reducedMotion(): boolean {
  return document.documentElement.dataset.reduceMotion === '1' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** the document's theme, followed live (the cafe's day / night follows it unless the toggle says otherwise) */
function useDocTheme(): string {
  const [t, setT] = useState(() => document.documentElement.dataset.theme ?? 'dark');
  useEffect(() => {
    const mo = new MutationObserver(() => setT(document.documentElement.dataset.theme ?? 'dark'));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return t;
}

function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const defIds = new WeakMap<CharacterDef, number>();
let defSeq = 0;
const defId = (d: CharacterDef) => { let n = defIds.get(d); if (!n) { n = ++defSeq; defIds.set(d, n); } return n; };

function botLabel(b: OfficeBot, f: OfficeZone): string {
  return `${b.name} · ${statusWord(b.status)} · ${zoneName(f)} ${f.name}${b.line ? ` · ${b.line}` : ''}`;
}

function Bubble({ b, near }: { b: OfficeBot; near: boolean }) {
  if (b.status === 'waiting') return <span className="ob-tag wait"><b className="ob-bang">!</b>{near || b.lead ? tr('需要你') : null}</span>;
  if (b.status === 'stuck') return <span className="ob-tag stuck"><Icon name="alert" size={11} />{near ? tr('卡住了') : null}</span>;
  if (!near) return null;
  if (b.status === 'working') return <span className="ob-dots" aria-hidden><i /><i /><i /></span>;
  if (b.status === 'finished') return <><span className="ob-ok" aria-hidden><Icon name="check" size={11} /></span><span className="ob-receipt" aria-hidden><i>{tr('结账')}</i>{b.usd !== undefined ? usd(b.usd) : ''}</span></>;
  return <span className="ob-zz" aria-hidden>z</span>;
}

/** the zone's people as dots: the left panel's row */
function FloorDots({ f }: { f: OfficeZone }) {
  const bots = f.bots.filter((b) => !b.lead).slice(0, 7);
  return <span className="of-dots" aria-hidden>{bots.map((b) => <i key={b.id} style={{ background: DOT[b.status] }} />)}</span>;
}

function Badges({ f }: { f: OfficeZone }) {
  return (
    <>
      {f.waiting > 0 && <span className="o-badge wait" title={tr('等你')}>{f.waiting}</span>}
      {f.stuck > 0 && <span className="o-badge stuck" title={tr('卡住了')}>{f.stuck}</span>}
    </>
  );
}

function Chip({ f, sm }: { f: OfficeZone; sm?: boolean }) {
  return <span className={clsx('of-chip', sm && 'sm')} style={{ '--c': agentColor(f.color) } as CSSProperties}>{f.letter}</span>;
}

export function Office({ compact, follow, onFloor, onOpenAgent, onOpenChat }: OfficeProps) {
  const sessions = useBackground((s) => s.sessions);
  const open = useStore((s) => s.open);
  const list = useStore((s) => s.sessions);
  const respond = useStore((s) => s.respondPermission);
  const light = useStore((s) => s.settings['office.light']);
  const chars = useCafe((s) => s.byId);
  const assign = useCafe((s) => s.assign);
  const theme = useDocTheme();
  const night = light === 'night' ? true : light === 'day' ? false : !(theme === 'light' || theme === 'paper');

  const model: OfficeModel = useMemo(() => officeModel({
    sessions,
    titleOf: (sid) => { const x = list.find((v) => v.sessionId === sid); return x?.customTitle || x?.title || ''; },
    // open here: its own state and requests; else what the list says (another window or machine holds it)
    lead: (sid) => { const o = open[sid]; return o ? { state: o.state, pending: o.pending, error: o.error } : { state: list.find((v) => v.sessionId === sid)?.live }; },
  }), [sessions, list, open]);

  const [focusSid, setFocusSid] = useState<string | undefined>(compact ? follow : undefined);
  const [sel, setSel] = useState<string | undefined>(undefined);
  const floorIndex = focusSid ? model.zones.findIndex((f) => f.sessionId === focusSid) : -1;
  const focusFloor = floorIndex >= 0 ? model.zones[floorIndex] : undefined;
  const selBot = sel ? model.zones.flatMap((f) => f.bots).find((b) => b.id === sel) : undefined;
  const selFloor = selBot ? model.zones.find((f) => f.sessionId === selBot.sessionId) : undefined;

  // follow a conversation picked elsewhere (not on the first render of the page: it opens on the whole cafe)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (follow && model.zones.some((f) => f.sessionId === follow)) { setFocusSid(follow); setSel(undefined); }
  }, [follow]); // eslint-disable-line react-hooks/exhaustive-deps

  // seats (PCs per zone, rooms over the hall), stable across snapshots
  const seats = useRef(new Map<string, Map<string, number>>());
  const roomSeats = useRef(new Map<string, number>());
  const sceneZones: SceneZone[] = useMemo(() => {
    const shells = model.zones.flatMap((f) => f.bots.filter((b) => b.shell));
    const rooms = seatRooms(shells, roomSeats.current, roomsFor(model.zones.length));
    roomSeats.current = rooms;
    return model.zones.map((f) => {
      const s = seatBots(f.bots, seats.current.get(f.sessionId) ?? new Map());
      seats.current.set(f.sessionId, s);
      const accent = agentHex(f.color);
      return {
        key: f.sessionId, name: f.name, letter: f.letter, accent,
        bots: f.bots.flatMap((b) => {
          const seat = b.lead ? -1 : b.shell ? rooms.get(b.id) : s.get(b.id);
          if (seat === undefined) return [];
          const cid = resolveCharacter(assign, b.lead ? { admin: true } : { type: b.type, name: b.name }, (id) => chars.has(id));
          const def = chars.get(cid);
          const custom = !b.shell && def && !def.builtin ? def : undefined;
          return [{
            id: b.id, kind: b.lead ? ('lead' as const) : b.shell ? ('shell' as const) : ('customer' as const), seat, status: b.status, color: b.lead ? accent : agentHex(b.color), shape: b.shape,
            sprite: custom ? (bakeCharacter(custom, undefined, 'se', 'stand', 0) as HTMLCanvasElement) : undefined,
            look: custom ? `c${defId(custom)}` : `s${b.shape}`,
          }];
        }),
      };
    });
  }, [model, chars, assign]);
  const seated = useMemo(() => new Set(sceneZones.flatMap((f) => f.bots.map((b) => b.id))), [sceneZones]);

  // ---- the scene
  const wrap = useRef<HTMLDivElement>(null);
  const can = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const scene = useRef<CafeScene | null>(null);
  const [broken, setBroken] = useState(() => !webglOk());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (broken || !can.current || !wrap.current) return;
    let sc: CafeScene;
    try { sc = new CafeScene(can.current, { sign: tr('Claude 网吧'), room: tr('包间') }); } catch { setBroken(true); return; }
    scene.current = sc;
    sc.reduced = reducedMotion();
    const box = wrap.current;
    const size = () => {
      const r = box.getBoundingClientRect();
      const left = !compact && side.current ? side.current.getBoundingClientRect().width + 20 : 0;
      const right = card.current ? card.current.getBoundingClientRect().width + 20 : 0;
      sc.resize(Math.round(r.width), Math.round(r.height), { left, right });
    };
    const ro = new ResizeObserver(size);
    ro.observe(box);
    if (side.current) ro.observe(side.current);
    const io = new IntersectionObserver((es) => { sc.visible = es.some((e) => e.isIntersecting); });
    io.observe(box);
    const lost = (e: Event) => { e.preventDefault(); setBroken(true); };
    can.current.addEventListener('webglcontextlost', lost);
    const c = can.current;
    sc.start();
    setReady(true);
    (window as any).__cwCafe = sc;
    return () => { ro.disconnect(); io.disconnect(); c.removeEventListener('webglcontextlost', lost); sc.dispose(); scene.current = null; if ((window as any).__cwCafe === sc) delete (window as any).__cwCafe; };
  }, [broken, compact]);

  useEffect(() => { scene.current?.setZones(sceneZones); }, [sceneZones, ready]);
  useEffect(() => { scene.current?.setNight(night, !ready); }, [night, ready]);
  useEffect(() => { scene.current?.focus(floorIndex); }, [floorIndex, model.zones.length, ready]);
  // the card on the right takes room: the camera re-fits around it
  useLayoutEffect(() => {
    const sc = scene.current, box = wrap.current;
    if (!sc || !box) return;
    const r = box.getBoundingClientRect();
    const left = !compact && side.current ? side.current.getBoundingClientRect().width + 20 : 0;
    const right = card.current ? card.current.getBoundingClientRect().width + 20 : 0;
    sc.resize(Math.round(r.width), Math.round(r.height), { left, right });
  }, [sel, focusSid, ready, compact]);
  useLayoutEffect(() => { scene.current?.bindOverlays(layer.current); });

  // ---- input: drag rotates, right-drag pans, the wheel zooms (a native non-passive listener), a click picks
  const drag = useRef<{ x: number; y: number; b: number; moved: boolean; id: number } | null>(null);
  const pickAt = (e: { clientX: number; clientY: number }) => {
    const sc = scene.current, c = can.current;
    if (!sc || !c) return;
    const r = c.getBoundingClientRect();
    const hit = sc.pick(e.clientX - r.left, e.clientY - r.top);
    if (hit.bot) chooseBot(hit.bot);
    else if (hit.zone !== undefined && model.zones[hit.zone]) chooseFloor(model.zones[hit.zone].sessionId);
  };
  const chooseFloor = (sid: string | undefined) => {
    setFocusSid(sid);
    setSel(undefined);
    if (sid) onFloor?.(sid);
  };
  const chooseBot = (id: string) => {
    const b = model.zones.flatMap((f) => f.bots).find((x) => x.id === id);
    if (!b) return;
    setSel(id);
    if (focusSid !== b.sessionId) { setFocusSid(b.sessionId); onFloor?.(b.sessionId); }
  };
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e: WheelEvent) => {
    const sc = scene.current;
    if (!sc) return;
    const z = wheelZoom(sc.zoom(), e, { min: 0.45, max: 3.5, step: 1.2 });
    if (z === null) return;
    e.preventDefault();
    sc.setZoom(z);
  };
  useEffect(() => {
    const c = can.current;
    if (!c) return;
    const on = (e: WheelEvent) => wheel.current(e);
    c.addEventListener('wheel', on, { passive: false });
    return () => c.removeEventListener('wheel', on);
  }, [broken]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || imeComposing(e.nativeEvent)) return;
    if (sel) { setSel(undefined); e.stopPropagation(); }
    else if (focusSid && !compact) { chooseFloor(undefined); e.stopPropagation(); }
  };

  const now = useTick(!!selBot);
  const { counts } = model;
  const spend = model.usd > 0 || !model.unpriced ? usd(model.usd) : usd(undefined);

  const pill = (
    <div className="office-pill" role="status">
      <span><i style={{ background: DOT.working }} />{tr('{n} 在干活', { n: counts.working })}</span>
      <span><i style={{ background: DOT.waiting }} />{tr('{n} 等你', { n: counts.waiting })}</span>
      <span><i style={{ background: DOT.stuck }} />{tr('{n} 卡住', { n: counts.stuck })}</span>
      <span><i style={{ background: DOT.resting }} />{tr('{n} 歇着', { n: counts.resting })}</span>
      {!compact && <span className="spend" title={tr('只按输入单价估，实际会更高')}>{spend}</span>}
    </div>
  );

  const waitCards = model.waiting.slice(0, 6).map((w) => {
    const b = model.zones.flatMap((f) => f.bots).find((x) => x.id === w.botId);
    return (
      <div key={w.key} className={clsx('ow-card', w.kind)}>
        <button type="button" className="ow-head" onClick={() => chooseBot(w.botId)}>
          <span className="ow-ic"><Icon name={w.kind === 'stuck' ? 'alert' : 'bell'} size={13} /></span>
          <span className="ow-t"><b>{w.name}</b><span className="sub">{tr('{z}区', { z: String.fromCharCode(64 + w.zone) })} {w.zoneName}</span></span>
        </button>
        <div className="ow-why">{w.kind === 'stuck' ? tr('为什么卡住：{v}', { v: w.reason }) : w.reason}</div>
        <div className="ow-acts">
          {w.requestId && !w.question && <button type="button" className="btn sm primary" onClick={() => void respond(w.requestId!, { behavior: 'allow' })}>{tr('允许')}</button>}
          {w.requestId && !w.question && <button type="button" className="btn sm" onClick={() => void respond(w.requestId!, { behavior: 'deny', message: tr('用户拒绝') })}>{tr('拒绝')}</button>}
          <button type="button" className="btn sm ghost" onClick={() => (b?.agentKey && b.taskId ? onOpenAgent(w.sessionId, b.taskId, b.agentKey) : onOpenChat(w.sessionId))}>{tr('打开对话')}</button>
        </div>
      </div>
    );
  });

  const sidePanel = !compact && (
    <div className="office-side" ref={side}>
      <section className="o-panel">
        <div className="o-h"><span>{tr('各区')}</span><span className="n">{model.zones.length}</span></div>
        <div className="of-list">
          {model.zones.map((f) => (
            <button key={f.sessionId} type="button" className={clsx('of-row', focusSid === f.sessionId && 'on')} data-sid={f.sessionId} onClick={() => chooseFloor(f.sessionId)}>
              <Chip f={f} />
              <span className="of-t"><span className="nm">{f.name}</span><span className="sub"><FloorDots f={f} />{tr('{n} 在干活', { n: f.working })}</span></span>
              <Badges f={f} />
              <span className="of-n">{f.total}</span>
            </button>
          ))}
          {model.more > 0 && <div className="of-more">{tr('还有 {n} 个对话没放下', { n: model.more })}</div>}
          <button type="button" className={clsx('of-row whole', !focusSid && 'on')} onClick={() => chooseFloor(undefined)}>
            <span className="of-chip ghost"><Icon name="cafe" size={12} /></span>
            <span className="of-t"><span className="nm">{tr('整个网吧')}</span><span className="sub">{tr('{n} 在干活', { n: counts.working })}</span></span>
            <span className="of-n">{model.zones.reduce((n, f) => n + f.total, 0)}</span>
          </button>
        </div>
      </section>
      <section className="o-panel">
        <div className="o-h"><span>{tr('等你处理')}</span>{model.waiting.length > 0 && <span className="o-badge wait">{model.waiting.length}</span>}</div>
        {waitCards.length ? <div className="ow-list">{waitCards}</div> : <div className="o-none">{tr('现在没有要你处理的')}</div>}
      </section>
      {model.finished.length > 0 && (
        <section className="o-panel">
          <div className="o-h"><span>{tr('完成了')}</span><span className="n">{model.finished.length}</span></div>
          <div className="ofin-list">
            {model.finished.map((b) => (
              <button key={b.id} type="button" className="ofin-row" onClick={() => chooseBot(b.id)}>
                <Icon name="checkCircle" size={13} />
                <span className="of-t"><span className="nm">{b.name}</span><span className="sub">{b.line}</span></span>
                {b.endedAt && <time>{hhmm(b.endedAt)}</time>}
              </button>
            ))}
          </div>
        </section>
      )}
      {model.activity.length > 0 && (
        <section className="o-panel">
          <div className="o-h"><span>{tr('动态')}</span></div>
          <ol className="oa-list">
            {model.activity.slice(0, 14).map((e, i) => (
              <li key={`${e.at}-${i}`} className={`tone-${e.tone}`}>
                <time>{hhmm(e.at)}</time>
                <span className="who" style={e.color ? ({ '--c': agentColor(e.color) } as CSSProperties) : undefined}>{e.who}</span>
                <span className="tx">{e.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );

  const botCard = selBot && selFloor && (() => {
    const b = selBot, f = selFloor;
    const ms = b.startedAt ? Math.max(0, (b.endedAt ?? now) - b.startedAt) : undefined;
    const evs = (sessions[b.sessionId]?.events ?? []).filter((e) => (b.lead ? !e.agent : b.agentKey ? e.agent === b.agentKey && e.taskId === b.taskId : e.taskId === b.taskId)).slice(-5).reverse();
    const wait = model.waiting.find((w) => w.botId === b.id);
    const running = !b.lead && b.taskId && sessions[b.sessionId]?.tasks.find((t) => t.id === b.taskId)?.status === 'running';
    return (
      <div className="office-card" ref={card} role="dialog" aria-label={b.name} style={{ '--c': b.lead ? agentColor(f.color) : b.color ? agentColor(b.color) : 'var(--ink-3)' } as CSSProperties}>
        <div className="oc-head">
          <span className="oc-av" aria-hidden />
          <div className="oc-t"><b>{b.name}</b><span className="sub">{zoneName(f)} {f.name}{b.type ? ` · ${b.type}` : b.shell ? ` · ${tr('包间')} · ${tr('后台命令')}` : ''}</span></div>
          <span className={clsx('oc-st', b.status)}>{statusWord(b.status)}</span>
          <button type="button" className="icon-btn sm" aria-label={tr('关闭')} title={tr('关闭')} onClick={() => setSel(undefined)}><Icon name="close" size={13} /></button>
        </div>
        {wait && (
          <div className={clsx('oc-ask', wait.kind)}>
            <div>{wait.reason}</div>
            {wait.requestId && !wait.question && (
              <div className="ow-acts">
                <button type="button" className="btn sm primary" onClick={() => void respond(wait.requestId!, { behavior: 'allow' })}>{tr('允许')}</button>
                <button type="button" className="btn sm" onClick={() => void respond(wait.requestId!, { behavior: 'deny', message: tr('用户拒绝') })}>{tr('拒绝')}</button>
              </div>
            )}
          </div>
        )}
        {(b.task || b.lead) && (
          <div className="oc-sec">
            <div className="o-h"><span>{tr('任务')}</span>{b.phase && <span className="n">{b.phase}</span>}</div>
            <div className="oc-task">{b.lead ? f.name : b.task}</div>
            <div className="oc-now"><i style={{ background: DOT[b.status] }} />{b.line}</div>
          </div>
        )}
        <div className="oc-stats">
          <div><b>{ms !== undefined ? clock(ms) : '—'}</b><span>{tr('用时')}</span></div>
          <div><b>{b.tokens ? tokensText(b.tokens) : '—'}</b><span>token</span></div>
          <div><b>{b.usd !== undefined ? `$${b.usd < 0.01 ? b.usd.toFixed(3) : b.usd.toFixed(2)}` : '—'}</b><span>{tr('费用')}</span></div>
          <div><b>{b.toolCalls ?? '—'}</b><span>{tr('工具调用')}</span></div>
        </div>
        {evs.length > 0 && (
          <div className="oc-sec">
            <div className="o-h"><span>{tr('最近')}</span></div>
            <ol className="oa-list">{evs.map((e, i) => <li key={`${e.at}-${i}`} className={`tone-${e.tone}`}><time>{hhmm(e.at)}</time><span className="tx">{e.text}</span></li>)}</ol>
          </div>
        )}
        <div className="oc-acts">
          {(b.lead || (b.agentKey && b.taskId)) && <button type="button" className="btn sm primary" onClick={() => (b.lead ? onOpenChat(b.sessionId) : onOpenAgent(b.sessionId, b.taskId!, b.agentKey!))}><Icon name="chat" size={13} /><span className="l">{tr('打开对话')}</span></button>}
          <button type="button" className="btn sm" onClick={() => { setSel(undefined); setFocusSid(b.sessionId); }}><Icon name="cafe" size={13} /><span className="l">{tr('看这一区')}</span></button>
          {running && <button type="button" className="btn sm" onClick={() => stopTask(b.sessionId, b.taskId!)}><Icon name="stop" size={12} /><span className="l">{tr('停止')}</span></button>}
        </div>
      </div>
    );
  })();

  const floorCard = !botCard && focusFloor && (
    <div className="office-card floor" ref={card} style={{ '--c': agentColor(focusFloor.color) } as CSSProperties}>
      <div className="oc-head">
        <Chip f={focusFloor} />
        <div className="oc-t"><b>{focusFloor.name}</b><span className="sub">{tr('{a} 个在干活 · 共 {b} 个', { a: focusFloor.working, b: focusFloor.total })}</span></div>
        <Badges f={focusFloor} />
        {!compact && <button type="button" className="icon-btn sm" aria-label={tr('整个网吧')} title={tr('整个网吧')} onClick={() => chooseFloor(undefined)}><Icon name="close" size={13} /></button>}
      </div>
      <div className="ofl-list">
        {focusFloor.bots.map((b) => (
          <button key={b.id} type="button" className="ofl-row" onClick={() => chooseBot(b.id)}>
            <i className="dot" style={{ background: b.lead ? agentColor(focusFloor.color) : b.color ? agentColor(b.color) : 'var(--ink-3)' }} />
            <span className="of-t"><span className="nm">{b.name}</span><span className="sub"><span style={{ color: DOT[b.status] }}>{statusWord(b.status)}</span> · {b.line}</span></span>
          </button>
        ))}
      </div>
      <div className="oc-acts">
        <button type="button" className="btn sm" onClick={() => onOpenChat(focusFloor.sessionId)}><Icon name="chat" size={13} /><span className="l">{tr('打开对话')}</span></button>
      </div>
    </div>
  );

  const zoomBy = (f: number) => { const sc = scene.current; if (sc) sc.setZoom(Math.max(0.45, Math.min(3.5, sc.zoom() * f))); };
  const setLight = (v: 'day' | 'night' | null) => void useStore.getState().setSetting('office.light', v);

  if (broken) {
    return (
      <div className={clsx('office office-flat', compact && 'compact')} onKeyDown={onKey}>
        {pill}
        {!model.zones.length ? <EmptyState e={EMPTY.background} /> : (
          <div className="office-flat-list">
            <div className="o-note">{tr('这台电脑上画不了 3D，下面是列表')}</div>
            {model.zones.map((f) => (
              <section key={f.sessionId} className="o-panel">
                <div className="o-h"><Chip f={f} sm /><span>{f.name}</span><Badges f={f} /></div>
                {f.bots.map((b) => (
                  <button key={b.id} type="button" className="ofl-row office-bot" aria-label={botLabel(b, f)} onClick={() => (b.lead ? onOpenChat(b.sessionId) : b.agentKey && b.taskId ? onOpenAgent(b.sessionId, b.taskId, b.agentKey) : undefined)}>
                    <i className="dot" style={{ background: DOT[b.status] }} />
                    <span className="of-t"><span className="nm">{b.name}</span><span className="sub">{statusWord(b.status)} · {b.line}</span></span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    );
  }

  const bread = (
    <div className="office-bread">
      <button type="button" className={clsx(!focusFloor && 'on')} onClick={() => chooseFloor(undefined)} disabled={compact && !focusFloor}><Icon name="cafe" size={12} />{tr('整个网吧')}</button>
      {focusFloor && <><Icon name="chevronRight" size={11} /><span className="on">{zoneName(focusFloor)} {focusFloor.name}</span></>}
    </div>
  );

  return (
    <div className={clsx('office', compact && 'compact', night ? 'night' : 'day')} ref={wrap} onKeyDown={onKey}>
      <canvas
        ref={can}
        className="office-canvas"
        aria-hidden
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, b: e.button, moved: false, id: e.pointerId }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => {
          const d = drag.current, sc = scene.current;
          if (!d || !sc) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          d.moved = true;
          d.x = e.clientX; d.y = e.clientY;
          if (d.b === 2 || e.shiftKey) sc.pan(dx, dy); else sc.rotate(dx, dy);
        }}
        onPointerUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved && d.b === 0) pickAt(e); }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => scene.current?.reset()}
      />
      <div className="office-anchors" ref={layer}>
        {!focusFloor && model.zones.map((f, i) => (
          <button key={f.sessionId} type="button" className={clsx('office-ftag', focusSid === f.sessionId && 'on')} data-anchor={`zone:${i}`} style={{ '--c': agentColor(f.color) } as CSSProperties} onClick={() => chooseFloor(f.sessionId)} aria-label={tr('{z}区 · {name}', { z: f.letter, name: f.name })}>
            <span className="of-chip sm">{f.letter}</span>
            <span className="nm">{f.name}</span>
            <span className="ct">{f.working}/{f.total}</span>
            <Badges f={f} />
          </button>
        ))}
        {model.zones.filter((f) => !focusFloor || f === focusFloor).flatMap((f) => f.bots.filter((b) => seated.has(b.id)).map((b) => {
          const near = focusSid === f.sessionId;
          return (
            <button key={b.id} type="button" className={clsx('office-bot', b.status, near && 'near', sel === b.id && 'sel')} data-anchor={`bot:${b.id}`} data-status={b.status} aria-label={botLabel(b, f)} title={botLabel(b, f)} onClick={() => chooseBot(b.id)}>
              <Bubble b={b} near={near} />
              {near && (sel === b.id || b.lead) && <span className="ob-name">{b.name}</span>}
            </button>
          );
        }))}
      </div>
      {pill}
      {sidePanel}
      {botCard || floorCard}
      {!model.zones.length && <div className="office-empty"><EmptyState e={EMPTY.background} /></div>}
      <div className="office-bottom">
        {bread}
        {!compact && <span className="office-hint">{tr('拖动旋转 · 右键拖动平移 · 滚轮缩放')}</span>}
        <span className="office-zoom">
          <button type="button" className="icon-btn sm" aria-label={tr('缩小')} title={tr('缩小')} onClick={() => zoomBy(1 / 1.25)}><Icon name="minus" size={13} /></button>
          <button type="button" className="icon-btn sm" aria-label={tr('放大')} title={tr('放大')} onClick={() => zoomBy(1.25)}><Icon name="plus" size={13} /></button>
        </span>
      </div>
      <div className="office-tools">
        <div className="office-seg" role="group" aria-label={tr('白天 / 夜里')}>
          <button type="button" className={clsx(!light && 'on')} aria-pressed={!light} title={tr('跟着主题')} onClick={() => setLight(null)}><Icon name="monitor" size={12} /></button>
          <button type="button" className={clsx(light === 'day' && 'on')} aria-pressed={light === 'day'} title={tr('白天')} onClick={() => setLight('day')}><Icon name="sun" size={12} />{!compact && <span className="l">{tr('白天')}</span>}</button>
          <button type="button" className={clsx(light === 'night' && 'on')} aria-pressed={light === 'night'} title={tr('夜里')} onClick={() => setLight('night')}><Icon name="moon" size={12} />{!compact && <span className="l">{tr('夜里')}</span>}</button>
        </div>
        {!compact && <button type="button" className="btn sm office-lib" onClick={openLibrary}><Icon name="user" size={13} /><span className="l">{tr('角色库')}</span></button>}
      </div>
    </div>
  );
}
