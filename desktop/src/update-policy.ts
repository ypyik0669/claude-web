// The app's own updates, the parts that decide rather than do (main.ts wires them to electron-updater). No electron
// imports: desktop/src/update-policy.test.ts runs them under vitest.
//
// Before v0.1.3 nothing ever looked for a new version by itself — only 设置 → 高级 → 更新 did, so nobody updated.
// Now: the Windows installer build downloads a new release in the background and asks to restart into it; builds
// that cannot install one themselves get the same prompt with a download button instead — macOS (unsigned: Squirrel.Mac
// refuses to install an update without an Apple signature), the portable exe (electron-updater does not update it),
// Linux. A release whose notes carry REQUIRED_MARK cannot be put off.

export type UpdateMode = 'auto' | 'manual';

/** The Windows installer (NSIS) downloads and installs by itself; everything else is told where to download. */
export function updateMode(platform: string, env: Record<string, string | undefined>): UpdateMode {
  return platform === 'win32' && !env.PORTABLE_EXECUTABLE_FILE ? 'auto' : 'manual';
}

/** Written into a release's notes, it makes the prompt for that release impossible to dismiss. */
export const REQUIRED_MARK = '【必须更新】';
export const isRequired = (notes: string | undefined): boolean => !!notes && notes.includes(REQUIRED_MARK);

/** The first look shortly after start (the window and the server come first), then every few hours. */
export const FIRST_CHECK_MS = 15_000;
export const CHECK_EVERY_MS = 4 * 60 * 60_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * electron-updater's `releaseNotes` as plain text: from GitHub it is the release body rendered to HTML (an array of
 * `{version, note}` when full changelogs are on); from a generic feed, whatever latest.yml says.
 */
export function notesText(n: unknown): string | undefined {
  if (Array.isArray(n)) {
    const parts = n.map((x) => notesText((x as { note?: unknown } | null)?.note)).filter((x): x is string => !!x);
    return parts.length ? parts.join('\n\n') : undefined;
  }
  if (typeof n !== 'string') return undefined;
  // HTML's own line breaks mean nothing: the block tags decide (a paragraph / heading / list ends in a blank line)
  const text = n
    .replace(/>\s*\n\s*</g, '><')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(li|tr|div)>/gi, '\n')
    .replace(/<\/(p|h[1-6]|pre|blockquote|ul|ol|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  for (const l of lines) if (l || (out.length && out[out.length - 1])) out.push(l);
  const s = out.join('\n').trim();
  return s || undefined;
}

export interface ManualTarget {
  /** owner/repo on GitHub */
  repo: string;
  version: string;
  platform: string;
  arch: string;
  /** an x64 build running on Apple Silicon (Rosetta): offer the arm64 one */
  arm64Translated?: boolean;
  portable?: boolean;
  /** a generic feed (end-to-end checks): files sit next to latest.yml */
  feed?: string;
}

/** The file a build that cannot update itself should download: its own kind, for this machine. */
export function manualDownloadUrl(t: ManualTarget): string {
  const v = t.version;
  const base = t.feed ? t.feed.replace(/\/*$/, '/') : `https://github.com/${t.repo}/releases/download/v${v}/`;
  if (t.platform === 'darwin') return `${base}ClaudeWeb-${v}-mac-${t.arch === 'arm64' || t.arm64Translated ? 'arm64' : 'x64'}.dmg`;
  if (t.platform === 'win32') return `${base}ClaudeWeb-${v}-${t.portable ? 'portable' : 'win-x64'}.exe`;
  return t.feed ? base : releasePage(t.repo, v); // Linux builds are not published: the release page says what there is
}

export const releasePage = (repo: string, version: string) => `https://github.com/${repo}/releases/tag/v${version}`;

/** An error's first line, for the status in settings (electron-updater's messages carry whole HTTP dumps). */
export const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300);
