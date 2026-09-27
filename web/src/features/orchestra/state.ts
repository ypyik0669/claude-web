// Client-side orchestration state, kept out of the main store: workflows, run summaries, full runs
// (from `orchestra.changed`), and what's waiting for a human (Mission Control reads that).
import { create } from 'zustand';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { useStore } from '@/store';
import type { OrchRun, OrchRunSummary, ServerEvent, Workflow, WorkflowTemplate } from '@shared';

export interface OrchWaiting { runId: string; runName: string; nodeId: string; title: string; kind: 'approval' | 'compare'; since?: number }
/** What the command palette asked the panel to show. */
export type OrchIntent = { mode: 'new' | 'run'; at: number } | { mode: 'open'; runId: string; at: number };

interface OrchState {
  workflows: Workflow[];
  templates: WorkflowTemplate[];
  runs: OrchRunSummary[];
  full: Record<string, OrchRun>;
  intent: OrchIntent | null;
  loadAll(): Promise<void>;
  loadRun(id: string): Promise<OrchRun | null>;
  ask(i: OrchIntent['mode'], runId?: string): void;
}

export function summarize(r: OrchRun): OrchRunSummary {
  const nodes = Object.values(r.nodes);
  return { id: r.id, workflowId: r.workflowId, name: r.name, cwd: r.cwd, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, total: nodes.length, done: nodes.filter((n) => n.state === 'done').length, waiting: nodes.filter((n) => n.state === 'waiting').length };
}

/** Nodes waiting for a human across every known run (approval / compare pick). */
export function waitingOf(full: Record<string, OrchRun>): OrchWaiting[] {
  const out: OrchWaiting[] = [];
  for (const r of Object.values(full)) {
    if (r.state !== 'waiting' && r.state !== 'running') continue;
    for (const n of r.workflow) {
      const nr = r.nodes[n.id];
      if (nr?.state !== 'waiting' || n.kind === 'task') continue;
      out.push({ runId: r.id, runName: r.name, nodeId: n.id, title: n.title || n.id, kind: n.kind, since: nr.startedAt });
    }
  }
  return out.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

export const useOrch = create<OrchState>((set, get) => ({
  workflows: [],
  templates: [],
  runs: [],
  full: {},
  intent: null,
  async loadAll() {
    // templates resolve agents against `agents.list`, whose version probes can take seconds on a cold
    // start — don't hold the workflow / run lists back for them
    void ws.request<WorkflowTemplate[]>({ kind: 'orchestra.templates' }).then((templates) => set({ templates })).catch(() => {});
    const [workflows, runs] = await Promise.all([
      ws.request<Workflow[]>({ kind: 'orchestra.workflows.list' }),
      ws.request<OrchRunSummary[]>({ kind: 'orchestra.runs.list' }),
    ]);
    set({ workflows, runs });
    // live runs are needed in full (Mission Control's "needs you" lane, notifications)
    await Promise.all(runs.filter((r) => r.state === 'running' || r.state === 'waiting').map((r) => get().loadRun(r.id)));
  },
  async loadRun(id) {
    const run = await ws.request<OrchRun>({ kind: 'orchestra.run.get', runId: id }).catch(() => null);
    if (run) set((s) => ({ full: { ...s.full, [id]: run } }));
    return run;
  },
  ask(mode, runId) {
    const st = useStore.getState();
    if (!st.panels.includes('orchestra')) st.togglePanel('orchestra');
    set({ intent: mode === 'open' ? { mode, runId: runId!, at: Date.now() } : { mode, at: Date.now() } });
  },
}));

let installed = false;
/** Subscribe once (App mount): keep runs fresh and notify when a node starts waiting for a human. */
export function installOrchestra() {
  if (installed) return;
  installed = true;
  const refresh = () => void useOrch.getState().loadAll().catch(() => {});
  ws.on((e: ServerEvent) => {
    if (e.kind === 'hello' || e.kind === 'orchestra.workflows.changed') { refresh(); return; }
    if (e.kind !== 'orchestra.changed') return;
    const prev = useOrch.getState().full[e.run.id];
    useOrch.setState((s) => {
      const sum = summarize(e.run);
      const runs = s.runs.some((r) => r.id === sum.id) ? s.runs.map((r) => (r.id === sum.id ? sum : r)) : [sum, ...s.runs];
      return { full: { ...s.full, [e.run.id]: e.run }, runs };
    });
    for (const w of waitingOf({ [e.run.id]: e.run })) {
      if (prev?.nodes[w.nodeId]?.state === 'waiting') continue;
      const body = w.kind === 'approval' ? `等你审批：${w.title}` : `候选都跑完了，选一个合并：${w.title}`;
      useStore.getState().toast(`编排「${w.runName}」${body}`, true);
      if (desktop && !document.hasFocus()) desktop.notify(`编排「${w.runName}」`, body);
    }
  });
  refresh();
}
