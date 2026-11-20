// The opening-pack skill's trial runs (界面改版方案 第 7 版 #opening「让 Claude 做一个」): the server hands a draft to this
// window (`openings.trial`); it plays over the window the way it plays at a start (试放一次: PreviewFrame.tsx, a web pack
// in its sandboxed frame), and the opening page reports what the pack did — when it said done or that it was cut, its
// errors, its frame times, pictures of its largest canvas. Those pictures go in one strip (trial-report.ts); the lot
// goes back (`openings.trialResult`). Modelled on the character themes' trial runs (themes/trial.ts).
import type { OpeningTrialResult, ServerEvent } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { tr } from '@/i18n';
import { playOpening } from './preview-state';
import { trialResult, type TrialReport } from './trial-report';

export type { TrialReport };

const answered = new Set<string>();

/** The trial `id` is over: answer once (a report, or why there is none). */
export function finishTrial(id: string, r: TrialReport | { note: string }): void {
  if (answered.has(id)) return;
  answered.add(id);
  const send = (res: OpeningTrialResult) => ws.request({ kind: 'openings.trialResult', id, ...res }).catch(() => {});
  if ('note' in r) { void send({ errors: [], note: r.note }); return; }
  void trialResult(r).then(send, (e) => send({ errors: [String(e?.message ?? e)] }));
}

/** This window plays the skill's trial runs (the most recent window that says so is asked). */
export function installOpeningTrials(): () => void {
  const announce = () => { if (useStore.getState().connected) void ws.request({ kind: 'openings.trialHost', on: true }).catch(() => {}); };
  const off = ws.on((e: ServerEvent) => {
    if (e.kind !== 'openings.trial') return;
    // a window nobody looks at cannot show it (and plays nothing: no frames come while it is hidden)
    if (document.visibilityState !== 'visible') { finishTrial(e.id, { note: tr('窗口被藏起来了（最小化或在托盘里），没法放给用户看。') }); return; }
    playOpening({ kind: 'web', pack: e.pack, html: e.html, trial: e.id });
  });
  const offStore = useStore.subscribe((s, p) => { if (s.connected && !p.connected) announce(); });
  window.addEventListener('focus', announce);
  announce();
  return () => { off(); offStore(); window.removeEventListener('focus', announce); };
}
