import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from '../files/service.js';
import { engineInfo } from '../claude-exe.js';
import { claudeDir } from '../sessions/service.js';

const execFileAsync = promisify(execFile);

/** Mask anything that looks like a secret in a JSON-ish text. */
export function maskSecrets(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{8,}/g, '$1…')
    .replace(/("(?:apiKey|api_key|token|authToken|password|secret)"\s*:\s*")([^"]{4})[^"]*(")/gi, '$1$2…$3')
    .replace(/(enc:(?:dpapi|keychain|plain):)[^"\s]+/g, '$1…');
}

export class DiagService {
  constructor(private version: string) {}

  /** Write a diagnostics folder + tar under ~/.claude-web/diagnostics and return both paths. */
  async bundle(extra: { settings?: Record<string, unknown>; providers?: unknown[]; sessionsCount?: number } = {}): Promise<{ dir: string; tar: string | null }> {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const dir = path.join(dataDir(), 'diagnostics', ts);
    await fs.mkdir(dir, { recursive: true });
    const eng = engineInfo();
    const info = {
      app: this.version,
      time: new Date().toISOString(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      electron: process.versions.electron ?? null,
      engine: eng,
      claudeDir,
      dataDir: dataDir(),
      memory: { rss: process.memoryUsage().rss, total: os.totalmem(), free: os.freemem() },
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GROK|XAI|NODE_|ELECTRON|PORT|HTTPS?_PROXY|NO_PROXY)/i.test(k)).map(([k, v]) => [k, /KEY|TOKEN|SECRET/i.test(k) ? '…' : v])),
      settings: extra.settings ?? {},
      providers: extra.providers ?? [],
      sessionsCount: extra.sessionsCount ?? null,
    };
    await fs.writeFile(path.join(dir, 'info.json'), maskSecrets(JSON.stringify(info, null, 2)), 'utf8');
    // logs written by the desktop shell (browser mode logs to stdout)
    const appData = process.env.APPDATA ? path.join(process.env.APPDATA, 'claude-web') : path.join(os.homedir(), '.config', 'claude-web');
    for (const f of ['server.log', 'main.log']) {
      const src = path.join(appData, f);
      const text = await fs.readFile(src, 'utf8').catch(() => '');
      if (text) await fs.writeFile(path.join(dir, f), maskSecrets(text.slice(-400_000)), 'utf8');
    }
    const meta = await fs.readFile(path.join(dataDir(), 'meta.json'), 'utf8').catch(() => '');
    if (meta) await fs.writeFile(path.join(dir, 'meta.json'), maskSecrets(meta), 'utf8');
    const settings = await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8').catch(() => '');
    if (settings) await fs.writeFile(path.join(dir, 'claude-settings.json'), maskSecrets(settings), 'utf8');
    try {
      const { stdout } = await execFileAsync('git', ['--version'], { windowsHide: true, timeout: 5000 });
      await fs.writeFile(path.join(dir, 'tools.txt'), stdout, 'utf8');
    } catch { /* ignore */ }
    let tar: string | null = path.join(dataDir(), 'diagnostics', `claude-web-diag-${ts}.tar`);
    try {
      await execFileAsync('tar', ['-cf', tar, '-C', path.join(dataDir(), 'diagnostics'), ts], { windowsHide: true, timeout: 60_000 });
    } catch {
      tar = null;
    }
    return { dir, tar };
  }
}
