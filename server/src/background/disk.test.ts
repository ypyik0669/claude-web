import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRuns, readAgentTranscript, readRun, sessionDirOf } from './disk.js';

let root: string;
let dir: string;
const SID = '3d17f956-4cb4-4981-94f2-6474a97a3ebf';
const prevConfig = process.env.CLAUDE_CONFIG_DIR;

// the shape the CLI saves (trimmed from a real run, 2026-09-04)
const run = (o: Record<string, unknown> = {}) => ({
  runId: 'wf_974df824-3c8', timestamp: '2026-09-03T17:23:04.627Z', taskId: 'wilzb31ol', script: 'export const meta = {}',
  agentCount: 2, durationMs: 226740, summary: 'Research reference agent UIs', workflowName: 'ui-benchmark-research', status: 'completed',
  startTime: 1788455957884, phases: [{ title: 'Research', detail: 'x' }, { title: 'Audit', detail: 'y' }], totalTokens: 454592, totalToolCalls: 143,
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Research' },
    { type: 'workflow_phase', index: 2, title: 'Audit' },
    { type: 'workflow_agent', index: 1, label: 'apps', phaseIndex: 1, phaseTitle: 'Research', agentId: 'a43605c938e2c3f74', model: 'claude-opus-5[1m]', state: 'done', startedAt: 1788456226345, queuedAt: 1788456226314, attempt: 1, lastToolName: 'StructuredOutput', lastToolSummary: 'Web research', promptPreview: 'READ-ONLY', lastProgressAt: 1, tokens: 100, toolCalls: 9, durationMs: 1000 },
    { type: 'workflow_agent', index: 2, label: 'audit-ui', phaseIndex: 2, phaseTitle: 'Audit', model: 'claude-opus-5[1m]', state: 'start', queuedAt: 1788456226315, promptPreview: 'x', lastProgressAt: 1 },
  ],
  ...o,
});

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cw-bg-disk-'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const proj = path.join(root, 'projects', 'C--Users-x');
  dir = path.join(proj, SID);
  mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  writeFileSync(path.join(proj, `${SID}.jsonl`), '{}\n');
  writeFileSync(path.join(dir, 'workflows', 'wf_974df824-3c8.json'), JSON.stringify(run()));
  writeFileSync(path.join(dir, 'workflows', 'wf_newer-1.json'), JSON.stringify(run({ startTime: 1788456000000, workflowName: 'newer', status: 'failed', error: 'Error: boom\n    at S (B:/~BUN/root/chunk-7dvkmj58.js:78:5225)\n    at run (unknown)' })));
  // stopped by the user (official 2.1.283, 2026-10-13): status killed, the abort's stack as the error, agents left in progress
  writeFileSync(path.join(dir, 'workflows', 'wf_killed-1.json'), JSON.stringify(run({ startTime: 1788455000000, workflowName: 'killed', status: 'killed', error: 'Error: Workflow aborted\n    at S (B:/~BUN/root/chunk-7dvkmj58.js:78:5225)\n    at abort (unknown)', workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'slow-a', state: 'progress', startedAt: 1788455000100, agentId: 'a1' }] })));
  writeFileSync(path.join(dir, 'workflows', 'wf_broken-1.json'), '{ half');
  // our engine names a run by its task id
  writeFileSync(path.join(dir, 'workflows', 'w8voqywjg.json'), JSON.stringify(run({ runId: 'w8voqywjg', taskId: 'w8voqywjg', startTime: 1788400000000, workflowName: 'engine-run' })));
  writeFileSync(path.join(dir, 'workflows', 'notes.txt'), 'not a run');
  mkdirSync(path.join(dir, 'subagents', 'workflows', 'wf_974df824-3c8'), { recursive: true });
  const line = (type: string, text: string) => JSON.stringify({ type, uuid: `${type}-1`, sessionId: SID, timestamp: '2026-09-03T17:23:05.000Z', message: { role: type, content: [{ type: 'text', text }] } });
  writeFileSync(path.join(dir, 'subagents', 'workflows', 'wf_974df824-3c8', 'agent-a43605c938e2c3f74.jsonl'), [line('user', 'go'), JSON.stringify({ type: 'progress' }), line('assistant', 'done'), ''].join('\n'));
  writeFileSync(path.join(dir, 'subagents', 'agent-b00000000001.jsonl'), line('assistant', 'plain sub-agent') + '\n');
});
afterAll(() => {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  rmSync(root, { recursive: true, force: true });
});

describe('background on disk', () => {
  it('finds the conversation folder beside its transcript', () => {
    expect(sessionDirOf(SID)).toBe(dir);
    expect(sessionDirOf('../../etc')).toBeNull();
    expect(sessionDirOf('ffffffff-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists the finished runs, newest first, skipping what does not parse', async () => {
    const runs = await listRuns(dir);
    expect(runs.map((r) => r.runId)).toEqual(['wf_newer-1', 'wf_974df824-3c8', 'wf_killed-1', 'w8voqywjg']);
    expect(runs[1]).toEqual({ runId: 'wf_974df824-3c8', name: 'ui-benchmark-research', status: 'completed', startedAt: 1788455957884, durationMs: 226740, agentCount: 2, tokens: 454592, taskId: 'wilzb31ol' });
    expect(await listRuns(path.join(root, 'nowhere'))).toEqual([]);
  });

  it('reads a run as a task with its phases and agents', async () => {
    const t = (await readRun(dir, 'wf_974df824-3c8'))!;
    expect(t).toMatchObject({ id: 'wilzb31ol', kind: 'workflow', name: 'ui-benchmark-research', status: 'completed', runId: 'wf_974df824-3c8', tokens: 454592, endedAt: 1788455957884 + 226740 });
    expect(t.phases).toEqual([{ index: 1, title: 'Research' }, { index: 2, title: 'Audit' }]);
    expect(t.agents.map((a) => [a.key, a.label, a.state, a.agentId, a.color])).toEqual([['w1', 'apps', 'done', 'a43605c938e2c3f74', 1], ['w2', 'audit-ui', 'done', undefined, 2]]);
    expect(JSON.stringify(t)).not.toContain('READ-ONLY');
    const failed = (await readRun(dir, 'wf_newer-1'))!;
    expect(failed).toMatchObject({ status: 'failed', reason: 'boom' });
    expect(failed.agents[1].state).toBe('failed');
    const killed = (await readRun(dir, 'wf_killed-1'))!;
    expect(killed.status).toBe('stopped');
    expect(killed.reason).toBeUndefined();
    expect(killed.agents.map((a) => a.state)).toEqual(['stopped']);
    expect(await readRun(dir, '../secret')).toBeNull();
    expect(await readRun(dir, 'wf_missing')).toBeNull();
  });

  // 2026-10-30: the run file says the main model for every agent; the picked subagent model is what really answered
  it('an agent\'s model is what its own transcript asked for', async () => {
    expect((await readRun(dir, 'wf_974df824-3c8'))!.agents[0].model).toBe('claude-opus-5[1m]'); // no model in its transcript: the file's
    const id = 'a9000000000000001';
    writeFileSync(path.join(dir, 'workflows', 'wsubmodel1.json'), JSON.stringify(run({ runId: 'wsubmodel1', taskId: 'wsubmodel1', workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'impl', state: 'done', agentId: id, model: 'claude-opus-5[1m]' }] })));
    mkdirSync(path.join(dir, 'subagents', 'workflows', 'wsubmodel1'), { recursive: true });
    writeFileSync(path.join(dir, 'subagents', 'workflows', 'wsubmodel1', `agent-${id}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n'));
    expect((await readRun(dir, 'wsubmodel1'))!.agents[0].model).toBe('claude-haiku-4-5');
  });

  it('reads a workflow agent or a plain sub-agent transcript', async () => {
    const msgs = await readAgentTranscript(dir, 'a43605c938e2c3f74') as any[];
    expect(msgs.map((m) => [m.type, m.message.content[0].text, m.parent_tool_use_id, m.session_id])).toEqual([['user', 'go', null, SID], ['assistant', 'done', null, SID]]);
    expect((await readAgentTranscript(dir, 'b00000000001') as any[]).length).toBe(1);
    expect(await readAgentTranscript(dir, '../../x')).toEqual([]);
    expect(await readAgentTranscript(dir, 'nothere000')).toEqual([]);
  });
});
