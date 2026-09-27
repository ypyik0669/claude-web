import { execFile, type ChildProcess } from 'node:child_process';

/**
 * Kill a child process and everything it started.
 *
 * `child.kill()` alone is not enough on Windows: a `.cmd` shim runs as cmd.exe → node → the real
 * binary (`opencode serve` is opencode.exe under node under cmd.exe), and killing the top pid leaves
 * the rest running — for `opencode serve` that's an unsecured HTTP server nobody owns any more. So on
 * win32 it's `taskkill /pid <pid> /t /f` (walks the tree by parent pid, so it has to run while the
 * top process is still alive); elsewhere SIGTERM, then SIGKILL after `graceMs` if it's still there.
 *
 * Resolves once the kill has been issued (taskkill finished / signal sent); never rejects.
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
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, graceMs);
  t.unref?.();
  return Promise.resolve();
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
