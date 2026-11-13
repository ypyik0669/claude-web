import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { forkAnchor } from './fork-anchor.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fork-anchor-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, 's.jsonl');
const OWN = '8c1139cb-e3ed-41d3-a1a8-5f0c2b7d9e11';
fs.writeFileSync(file, [
  { type: 'user', uuid: '11111111-2222-4333-8444-555555555555', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: OWN, parentUuid: '11111111-2222-4333-8444-555555555555', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'y' }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n');

// 2026-11-13 user report: 分叉 on a reply of a live conversation — "Message 8c1139cb-…-000000000001 not found in session"
describe('forkAnchor', () => {
  it('a per-block uuid from the wire becomes the message\'s own uuid in the transcript', () => {
    expect(forkAnchor(file, '8c1139cb-e3ed-41d3-a1a8-000000000001')).toBe(OWN);
    expect(forkAnchor(file, '8c1139cb-e3ed-41d3-a1a8-000000000000')).toBe(OWN);
  });
  it('a uuid the transcript has stays as it is', () => {
    expect(forkAnchor(file, OWN)).toBe(OWN);
    expect(forkAnchor(file, '11111111-2222-4333-8444-555555555555')).toBe('11111111-2222-4333-8444-555555555555');
  });
  it('nothing to go by: unchanged (the SDK says what is wrong)', () => {
    expect(forkAnchor(file, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-000000000001');
    expect(forkAnchor(null, '8c1139cb-e3ed-41d3-a1a8-000000000001')).toBe('8c1139cb-e3ed-41d3-a1a8-000000000001');
    expect(forkAnchor(path.join(dir, 'missing.jsonl'), '8c1139cb-e3ed-41d3-a1a8-000000000001')).toBe('8c1139cb-e3ed-41d3-a1a8-000000000001');
    expect(forkAnchor(file, undefined)).toBeUndefined();
  });
});
