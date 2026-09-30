import { useEffect, useRef, useState } from 'react';
import { desktop } from '@/desktop';
import { useStore } from '@/store';
import { imeComposing } from '@/ui/ime';
import { promptCopy, promptFor, type UpdateState } from './model';

/** 稍后, per version, for the life of this window (a restart asks again). */
const snoozed: Record<string, number> = {};

/**
 * The update prompt (desktop only, in the main window): the main process finds and — on the Windows installer —
 * downloads a new version by itself (desktop/src/main.ts, update-policy.ts); this asks to restart into it, or, where
 * the build cannot install it, points at the download. A release marked 必须更新 has no 稍后.
 */
export function UpdatePrompt() {
  const [st, setSt] = useState<UpdateState | null>(null);
  const [, setTick] = useState(0);
  const [opened, setOpened] = useState<string | null>(null); // version whose download was opened in the browser
  const [busy, setBusy] = useState(false);
  const running = useStore((s) => {
    let n = 0;
    for (const o of Object.values(s.open)) if (o.state === 'running' || o.state === 'waiting') n++;
    return n;
  });
  const toast = useStore((s) => s.toast);
  const primary = useRef<HTMLButtonElement>(null);
  const mainWindow = !!desktop && (desktop.windowId ?? 'main') === 'main';

  useEffect(() => {
    if (!mainWindow || !desktop?.onUpdate) return;
    const off = desktop.onUpdate((s: UpdateState) => setSt(s));
    void desktop.updateState?.().then((s: UpdateState | undefined) => { if (s) setSt(s); });
    return off;
  }, [mainWindow]);

  const p = mainWindow ? promptFor(st, snoozed, Date.now()) : null;
  const key = p ? `${p.kind}:${p.version}` : '';
  useEffect(() => { if (key) primary.current?.focus(); }, [key]);
  if (!p || !desktop) return null;
  const d = desktop;

  const c = promptCopy(p, { platform: d.platform, mode: st?.mode, portable: d.platform === 'win32' && st?.mode === 'manual', running });
  const later = () => { snoozed[p.version] = Date.now(); setOpened(null); setTick((t) => t + 1); };
  const install = async () => {
    setBusy(true);
    try {
      if (!(await d.installUpdate?.())) { toast('更新还没准备好，稍后再试'); setBusy(false); }
    } catch (e: any) { toast(e?.message ?? String(e)); setBusy(false); }
  };
  const download = () => { if (p.url) { void d.openExternal(p.url); setOpened(p.version); } };
  const copyLink = () => { if (p.url) void navigator.clipboard?.writeText(p.url).then(() => toast('下载链接已复制', true), () => toast(p.url!)); };
  const afterOpen = opened === p.version && p.kind === 'download';

  return (
    <div className="modal-bg dialog-bg update-bg" onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); if (!p.required) later(); } }}>
      <div className="modal update-prompt" role="dialog" aria-modal="true" aria-label={c.title} data-kind={p.kind} data-required={p.required || undefined}>
        <h3>{c.title}</h3>
        <p className="sub">{afterOpen ? c.after : c.lead}</p>
        {p.notes && !afterOpen && <div className="up-notes" tabIndex={0} aria-label="更新内容">{p.notes}</div>}
        {c.warn && <p className="up-warn">{c.warn}</p>}
        <div className="up-foot">
          {p.page && <button type="button" className="link" onClick={() => void d.openExternal(p.page!)}>查看完整更新内容</button>}
          {afterOpen && p.url && <button type="button" className="link" onClick={copyLink} title={p.url}>复制下载链接</button>}
          <span className="grow" />
          {!p.required && <button type="button" className="btn ghost" data-act="later" onClick={later}>{afterOpen ? '好的' : '稍后'}</button>}
          {afterOpen
            ? <button ref={primary} type="button" className="btn primary" data-act="quit" onClick={() => void d.quit?.()}>退出软件</button>
            : p.kind === 'ready'
              ? <button ref={primary} type="button" className="btn primary" data-act="install" disabled={busy} onClick={() => void install()}>{busy ? '正在重启…' : c.primary}</button>
              : <button ref={primary} type="button" className="btn primary" data-act="download" onClick={download}>{c.primary}</button>}
        </div>
        {c.later && !afterOpen && <p className="up-later">{c.later}</p>}
      </div>
    </div>
  );
}
