import { afterEach, describe, expect, it, vi } from 'vitest';

const runs: string[][] = [];
let reply: () => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: '' });
vi.mock('../claude-exe.js', () => ({ runClaudeCli: async (args: string[]) => { runs.push(args); return reply(); } }));
const { ConfigService } = await import('./service.js');

describe('ConfigService.auth', () => {
  afterEach(() => { runs.length = 0; });

  it('keeps a good answer, never an error: the next call asks the engine again', async () => {
    const svc = new ConfigService();
    reply = () => ({ code: 1, stdout: '', stderr: 'engine crashed' });
    expect(await svc.auth()).toMatchObject({ stderr: 'engine crashed' });
    reply = () => ({ code: 0, stdout: '{"loggedIn":true,"email":"a@b"}', stderr: '' });
    expect(await svc.auth()).toMatchObject({ loggedIn: true });
    expect(await svc.auth()).toMatchObject({ loggedIn: true });
    expect(runs).toHaveLength(2);
    await svc.auth(true); // 重新检查 / focus
    expect(runs).toHaveLength(3);
  });

  it('unparseable output counts as an error too', async () => {
    const svc = new ConfigService();
    reply = () => ({ code: 0, stdout: 'Error: something odd', stderr: '' });
    await svc.auth();
    await svc.auth();
    expect(runs).toHaveLength(2);
  });
});

describe('ConfigService.auth: logged out is an answer, not an error', () => {
  it('exit 1 with {"loggedIn":false} is kept like any answer', async () => {
    runs.length = 0;
    const svc = new ConfigService();
    reply = () => ({ code: 1, stdout: '{\n  "loggedIn": false,\n  "authMethod": "none"\n}', stderr: '' });
    expect(await svc.auth()).toMatchObject({ loggedIn: false });
    await svc.auth();
    expect(runs).toHaveLength(1);
  });
});
