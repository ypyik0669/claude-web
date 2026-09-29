import { execFile, type ChildProcess } from 'node:child_process';

/**
 * Every descendant of `root` in a `ps -A -o pid= -o ppid=` listing, breadth-first (children before
 * grandchildren). Lines that are not two numbers (a header, blank lines) are skipped. Pure: exported for tests.
 */
export function descendantsOf(root: number, table: string): number[] {
  const kids = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    if (pid === ppid) continue;
    const list = kids.get(ppid);
    if (list) list.push(pid); else kids.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set([root]);
  for (let i = -1; i < out.length; i++) {
    for (const k of kids.get(i < 0 ? root : out[i]) ?? []) if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/**
 * Kill a child process and everything it started.
 *
 * `child.kill()` alone is not enough: a launcher runs the real program as its child — on Windows a `.cmd`
 * shim is cmd.exe → node → the real binary (`opencode serve` is opencode.exe under node under cmd.exe), on
 * macOS / Linux a `#!/bin/sh` wrapper or a node launcher that spawns the native binary — and killing the
 * top pid leaves the rest running (for `opencode serve` that's an unsecured HTTP server nobody owns any
 * more). So on win32 it's `taskkill /pid <pid> /t /f`; elsewhere one `ps` snapshot of the tree, SIGTERM to
 * all of it, then SIGKILL after `graceMs` to whatever is still there. Both walk the tree by parent pid, so
 * they have to run while the top process is still alive. Without `ps` only the direct child is signalled.
 *
 * Resolves once the kill has been issued (taskkill finished / signals sent); never rejects.
 */
export function killTree(child: ChildProcess | null | undefined, graceMs = 3000): Promise<void> {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const pid = child.pid;
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => {
        // taskkill can fail (already gone, access denied): make sure at least the direct child goes
        if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { /* gone */ } }
        resolve();
      });
    });
  }
  const signal = (tree: number[], sig: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill(sig); } catch { /* gone */ } }
    for (const p of tree) { try { process.kill(p, sig); } catch { /* gone */ } }
  };
  return new Promise((resolve) => {
    // `-A -o pid= -o ppid=` means the same to BSD ps (macOS) and procps (Linux): every process, no header
    execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const tree = err ? [] : descendantsOf(pid, String(stdout));
      signal(tree, 'SIGTERM');
      const t = setTimeout(() => signal(tree, 'SIGKILL'), graceMs);
      t.unref?.();
      resolve();
    });
  });
}

/**
 * `execFile` whose timeout kills the whole process tree (execFile's own `timeout` only signals the
 * direct child — cmd.exe for a `.cmd` shim — and then waits for pipes the grandchild still holds).
 * `child` is exposed so an owner can kill an in-flight run early (with `killTree`).
 */
export function execFileTree(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; windowsVerbatimArguments?: boolean; timeoutMs: number },
): { child: ChildProcess; done: Promise<{ stdout: string; stderr: string }> } {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let child!: ChildProcess;
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = execFile(command, args, { env: opts.env, cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: opts.windowsVerbatimArguments, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) {
        const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
        e.stdout = String(stdout ?? '');
        e.stderr = String(stderr ?? '');
        if (timedOut) { e.message = `超时（${Math.round(opts.timeoutMs / 1000)} 秒）：${e.message}`; e.killed = true; }
        reject(e);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    timer = setTimeout(() => { timedOut = true; void killTree(child); }, opts.timeoutMs);
    timer.unref?.();
  });
  return { child, done };
}
