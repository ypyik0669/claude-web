import { execFile } from 'node:child_process';

export type OpenApp = 'explorer' | 'code' | 'cursor';

/** macOS app bundles for the editors `shell.open` knows (`open -a <name>`). */
const MAC_APPS: Record<Exclude<OpenApp, 'explorer'>, string> = { code: 'Visual Studio Code', cursor: 'Cursor' };

/**
 * Commands to try, in order, to show `p` in the file manager (`explorer`) or open it in an editor. On macOS the
 * editor's shell command is optional (VS Code only gets `code` after "Install 'code' command in PATH", and a
 * Finder-launched app may not see it), so `open -a <app>` — which finds the bundle through Launch Services —
 * comes next. Pure: exported for tests.
 */
export function openCommands(p: string, app: OpenApp = 'explorer', platform: NodeJS.Platform = process.platform): [string, string[]][] {
  if (app === 'explorer') return [[platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open', [p]]];
  return platform === 'darwin' ? [[app, [p]], ['open', ['-a', MAC_APPS[app], p]]] : [[app, [p]]];
}

/** Fire and forget: the next command is tried only when one is not installed (ENOENT). */
export function openPath(p: string, app: OpenApp = 'explorer') {
  const cmds = openCommands(p, app);
  const run = (i: number) => {
    const c = cmds[i];
    if (!c) return;
    execFile(c[0], c[1], { windowsHide: true }, (err) => { if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') run(i + 1); });
  };
  run(0);
}
