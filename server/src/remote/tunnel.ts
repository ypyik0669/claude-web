import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { RemoteHost, TunnelInfo } from '../protocol.js';

/**
 * SSH port-forward manager: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort> user@host` makes a claude-web
 * running on another machine reachable at http://127.0.0.1:<local>/. Uses the system ssh (keys / agent / config).
 */
export class TunnelManager extends EventEmitter {
  private tunnels = new Map<string, { info: TunnelInfo; proc: ChildProcess; log: string }>();

  list(): TunnelInfo[] { return [...this.tunnels.values()].map((t) => t.info); }

  async open(host: RemoteHost): Promise<TunnelInfo> {
    const existing = this.tunnels.get(host.id);
    if (existing && existing.info.state === 'up') return existing.info;
    if (existing) await this.close(host.id);
    assertTarget(host.target);
    if (host.startCommand?.trim()) await this.runRemote(host, host.startCommand.trim());
    const localPort = await freePort();
    const args = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new', '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${host.remotePort || 3090}`];
    if (host.sshPort) args.push('-p', String(host.sshPort));
    if (host.identityFile) args.push('-i', host.identityFile);
    args.push(host.target);
    const proc = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const info: TunnelInfo = { hostId: host.id, localPort, url: `http://127.0.0.1:${localPort}/${host.token ? `?token=${encodeURIComponent(host.token)}` : ''}`, state: 'connecting', error: '', since: Date.now() };
    const entry = { info, proc, log: '' };
    this.tunnels.set(host.id, entry);
    proc.stderr?.on('data', (d: Buffer) => { entry.log = (entry.log + d.toString()).slice(-2000); });
    proc.on('exit', (code) => { info.state = 'down'; info.error = info.error || `ssh 退出 ${code}${entry.log ? `: ${entry.log.trim().split('\n').pop()}` : ''}`; this.emit('changed'); });
    proc.on('error', (e) => { info.state = 'down'; info.error = e.message.includes('ENOENT') ? '找不到 ssh（请安装 OpenSSH 客户端）' : e.message; this.emit('changed'); });
    // wait until the local end accepts connections (ssh sets up the forward after auth)
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && info.state === 'connecting') {
      if (await canConnect(localPort)) { info.state = 'up'; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (info.state === 'connecting') { info.state = 'down'; info.error = entry.log.trim().split('\n').pop() || 'ssh 连接超时（检查密钥 / 主机名 / 端口）'; try { proc.kill(); } catch { /* ignore */ } }
    this.emit('changed');
    return info;
  }

  async close(hostId: string) {
    const t = this.tunnels.get(hostId);
    if (!t) return;
    this.tunnels.delete(hostId);
    try { t.proc.kill(); } catch { /* ignore */ }
    this.emit('changed');
  }

  async closeAll() { for (const id of [...this.tunnels.keys()]) await this.close(id); }

  /** Run a one-off command on the remote host (used to start claude-web there). Resolves when ssh exits or after 15s. */
  runRemote(host: RemoteHost, command: string): Promise<{ code: number | null; output: string }> {
    assertTarget(host.target);
    return new Promise((res) => {
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
      if (host.sshPort) args.push('-p', String(host.sshPort));
      if (host.identityFile) args.push('-i', host.identityFile);
      args.push(host.target, command);
      const p = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      p.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } res({ code: null, output: out.slice(-4000) }); }, 15_000);
      p.on('exit', (code) => { clearTimeout(t); res({ code, output: out.slice(-4000) }); });
      p.on('error', (e) => { clearTimeout(t); res({ code: -1, output: e.message }); });
    });
  }
}

/** A target like `-oProxyCommand=…` would be parsed by ssh as an option and run a local command. */
export function assertTarget(target: string) {
  if (!target?.trim() || target.trim().startsWith('-')) throw new Error(`无效的 SSH 目标：${target}`);
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); s.on('error', rej); });
}
function canConnect(port: number): Promise<boolean> {
  return new Promise((res) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); s.setTimeout(500, () => { s.destroy(); res(false); }); });
}
