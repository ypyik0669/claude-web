/**
 * Which application is this? — the names an agent asks for ("记事本", "Google Chrome", "msedge") against what Windows
 * says about the window in front (process name, the exe's FileDescription / ProductName). Pure: no process, no fs.
 *
 * The rules lean towards NOT matching. A grant is what lets input reach an app, so a loose match is a way around the
 * user's approval: "Word" must not reach 1Password, "Microsoft" must not reach everything Microsoft ships, and a
 * one-letter name must not reach anything it does not spell out exactly.
 *
 * The window title is never part of a match: a web page or a document chooses its own title.
 */

/** A top-level window and the process behind it, as the Windows helper reports it. */
export interface WindowApp {
  hwnd: number;
  pid: number;
  /** process name without `.exe` (for a UWP app: the app's process, not ApplicationFrameHost) */
  name: string;
  exe: string;
  description: string;
  product: string;
  title: string;
}

export interface KnownApp {
  /** what people call it (any case, any spacing) */
  names: string[];
  /** process names (without .exe) its windows belong to — the only thing a known name matches */
  procs: string[];
  /** something Start-Process can open: an exe on the App Paths / PATH, or a URI scheme. Ours, never the model's text. */
  launch?: string;
}

/** Common Windows apps: display names in English and Chinese → process names. */
export const KNOWN_APPS: KnownApp[] = [
  { names: ['Notepad', '记事本'], procs: ['notepad'], launch: 'notepad.exe' },
  // explorer.exe is also the desktop and the taskbar: clicking those needs this grant
  { names: ['File Explorer', 'Explorer', 'Windows Explorer', '文件资源管理器', '资源管理器', '文件管理器', 'Desktop', '桌面', 'Taskbar', '任务栏'], procs: ['explorer'], launch: 'explorer.exe' },
  { names: ['Start menu', 'Start', '开始菜单', 'Windows Search', '搜索'], procs: ['StartMenuExperienceHost', 'SearchHost', 'SearchApp'] },
  { names: ['Edge', 'Microsoft Edge', 'msedge'], procs: ['msedge'], launch: 'msedge' },
  { names: ['Chrome', 'Google Chrome', '谷歌浏览器'], procs: ['chrome'], launch: 'chrome' },
  { names: ['Firefox', 'Mozilla Firefox', '火狐', '火狐浏览器'], procs: ['firefox'], launch: 'firefox' },
  { names: ['Settings', 'Windows Settings', '设置'], procs: ['SystemSettings'], launch: 'ms-settings:' },
  { names: ['Terminal', 'Windows Terminal', '终端', 'wt'], procs: ['WindowsTerminal'], launch: 'wt.exe' },
  { names: ['Command Prompt', 'cmd', '命令提示符'], procs: ['cmd', 'conhost'], launch: 'cmd.exe' },
  { names: ['PowerShell', 'Windows PowerShell'], procs: ['powershell', 'pwsh'], launch: 'powershell.exe' },
  { names: ['Calculator', 'calc', '计算器'], procs: ['CalculatorApp', 'Calculator', 'calc'], launch: 'calc.exe' },
  { names: ['Paint', '画图', 'mspaint'], procs: ['mspaint'], launch: 'mspaint.exe' },
  { names: ['Snipping Tool', '截图工具'], procs: ['SnippingTool'], launch: 'snippingtool.exe' },
  { names: ['Photos', '照片'], procs: ['Photos', 'Microsoft.Photos'], launch: 'ms-photos:' },
  { names: ['Task Manager', '任务管理器'], procs: ['Taskmgr'], launch: 'taskmgr.exe' },
  { names: ['Microsoft Store', '应用商店', '微软商店'], procs: ['WinStore.App'], launch: 'ms-windows-store:' },
  { names: ['VS Code', 'VSCode', 'Visual Studio Code', 'Code'], procs: ['Code'] },
  { names: ['Word', 'Microsoft Word', 'winword'], procs: ['WINWORD'], launch: 'winword' },
  { names: ['Excel', 'Microsoft Excel'], procs: ['EXCEL'], launch: 'excel' },
  { names: ['PowerPoint', 'Microsoft PowerPoint', 'PPT', 'powerpnt'], procs: ['POWERPNT'], launch: 'powerpnt' },
  { names: ['Outlook', 'Microsoft Outlook'], procs: ['OUTLOOK', 'olk'], launch: 'outlook' },
  { names: ['OneNote', 'Microsoft OneNote'], procs: ['ONENOTE'], launch: 'onenote' },
  { names: ['Teams', 'Microsoft Teams'], procs: ['ms-teams', 'Teams'] },
  { names: ['WPS', 'WPS Office'], procs: ['wps', 'wpp', 'et', 'wpsoffice'] },
  { names: ['WeChat', 'Weixin', '微信'], procs: ['WeChat', 'Weixin', 'WeChatAppEx'] },
  { names: ['QQ', '腾讯QQ'], procs: ['QQ'] },
  { names: ['WeCom', '企业微信', 'WXWork'], procs: ['WXWork'] },
  { names: ['DingTalk', '钉钉'], procs: ['DingTalk'] },
  { names: ['Feishu', 'Lark', '飞书'], procs: ['Feishu', 'Lark'] },
  { names: ['Telegram', 'Telegram Desktop'], procs: ['Telegram'] },
  { names: ['NetEase Cloud Music', '网易云音乐', 'cloudmusic'], procs: ['cloudmusic'] },
  { names: ['QQ Music', 'QQ音乐', 'QQMusic'], procs: ['QQMusic'] },
];

/** Lowercase, width-folded, without `.exe`, spaces or punctuation: "Claude Web.exe" and "claude-web" are the same name. */
export function normalizeApp(s: string): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().trim().replace(/\.exe$/, '').replace(/[^\p{L}\p{N}+#]/gu, '');
}

/** The words of a name: "Microsoft® Word" → microsoft, word. */
export function appTokens(s: string): string[] {
  return String(s ?? '').normalize('NFKC').toLowerCase().trim().replace(/\.exe$/, '').split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);
}

/** kana, CJK ideographs, hangul: scripts written without spaces between words */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** Words that say nothing about which app: alone they match only a process spelled exactly that way. */
const GENERIC = new Set([
  'microsoft', 'windows', 'google', 'apple', 'adobe', 'app', 'apps', 'application', 'system', 'service', 'services', 'host', 'helper',
  'the', 'for', 'and', 'desktop', 'client', 'program', 'exe', 'inc', 'corporation', 'corp', 'llc', 'ltd', 'software', 'tool', 'tools',
  'update', 'updater', 'setup', 'installer', 'launcher', 'runtime', 'platform', 'binary', 'operating', 'win', 'web', 'online', 'new',
  'pro', 'free', 'beta', 'x64', 'x86', '应用', '程序', '软件', '客户端', '电脑版',
]);

/** A description or product that is the same for a whole family of programs ("Microsoft® Windows® Operating System"). */
function genericLabel(label: string): boolean {
  const n = normalizeApp(label);
  if (!n || n.includes('operatingsystem')) return true;
  return appTokens(label).every((t) => GENERIC.has(t));
}

const significant = (t: string) => !GENERIC.has(t) && (t.length >= 3 || (CJK.test(t) && t.length >= 2));

/** Is `short` a run of consecutive words inside `long`, with at least one word that means something? */
function wordsWithin(short: string[], long: string[]): boolean {
  if (!short.length || short.length > long.length || !short.some(significant)) return false;
  for (let i = 0; i + short.length <= long.length; i++) {
    let hit = true;
    for (let k = 0; k < short.length; k++) if (long[i + k] !== short[k]) { hit = false; break; }
    if (hit) return true;
  }
  return false;
}

const BY_NAME = new Map<string, KnownApp>();
for (const app of KNOWN_APPS) {
  for (const n of [...app.names, ...app.procs]) {
    const key = normalizeApp(n);
    if (key && !BY_NAME.has(key)) BY_NAME.set(key, app);
  }
}

/** The known app a name refers to, by any of its names or process names. */
export function knownApp(name: string): KnownApp | undefined {
  return BY_NAME.get(normalizeApp(name));
}

/**
 * Does the granted name `grant` cover this app?
 *
 *  - a known app (KNOWN_APPS) covers exactly its process names — "Word" is WINWORD and nothing that merely contains
 *    the letters;
 *  - otherwise the name must equal the process name, or the exe's FileDescription / ProductName;
 *  - or be a run of whole words in one of those two (or the other way round), with a word that means something;
 *  - or, from 5 characters up, contain / be contained in the process name ("Google Chrome" ⊇ chrome);
 *  - Chinese / Japanese / Korean names have no word breaks: from 2 characters, containment either way.
 *
 * Names of 1–2 characters only ever match by spelling something out exactly.
 */
export function grantCovers(grant: string, app: Pick<WindowApp, 'name' | 'description' | 'product'>): boolean {
  const g = normalizeApp(grant);
  const proc = normalizeApp(app.name);
  if (!g || !proc) return false;
  const known = BY_NAME.get(g);
  if (known) return known.procs.some((p) => normalizeApp(p) === proc);
  if (g === proc) return true;

  const labels = [app.description, app.product].filter((l) => l && !genericLabel(l));
  if (labels.some((l) => normalizeApp(l) === g)) return true;
  if (GENERIC.has(g)) return false;

  const cjk = CJK.test(g);
  if (g.length < (cjk ? 2 : 3)) return false;

  const gt = appTokens(grant);
  for (const l of labels) {
    const lt = appTokens(l);
    if (wordsWithin(gt, lt) || wordsWithin(lt, gt)) return true;
    if (cjk || CJK.test(l)) {
      const n = normalizeApp(l);
      const [short, long] = n.length <= g.length ? [n, g] : [g, n];
      if (short.length >= 2 && CJK.test(short) && long.includes(short)) return true;
    }
  }

  if (!GENERIC.has(proc)) {
    const [short, long] = proc.length <= g.length ? [proc, g] : [g, proc];
    if (short.length >= 5 && long.includes(short)) return true;
    if (cjk && CJK.test(short) && short.length >= 2 && long.includes(short)) return true;
  }
  return false;
}

/** How to name an app to the model: what its exe calls itself, else the process name. */
export function displayName(app: Pick<WindowApp, 'name' | 'description' | 'product'>): string {
  const label = [app.description, app.product].find((l) => l && !genericLabel(l));
  return (label || app.name || 'an unknown program').trim();
}

/** "Notepad (process notepad)" — the process name is what request_access matches most reliably. */
export function describeApp(app: Pick<WindowApp, 'name' | 'description' | 'product'>): string {
  const d = displayName(app);
  return app.name && normalizeApp(d) !== normalizeApp(app.name) ? `"${d}" (process ${app.name})` : `"${d}"`;
}

/** Same file? Windows paths: case and slash direction do not matter. */
export function sameExe(a: string | undefined, b: string | undefined): boolean {
  const norm = (p: string) => p.trim().replace(/^"|"$/g, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Pick the Start-menu entry a name refers to: the one spelled the same, else the shortest one the name's words run
 * through. Used to start an app that is not running and not in KNOWN_APPS — only ever an entry Windows lists.
 */
export function pickStartApp<T extends { name: string }>(name: string, entries: T[]): T | undefined {
  const g = normalizeApp(name);
  if (!g) return undefined;
  const exact = entries.find((e) => normalizeApp(e.name) === g);
  if (exact) return exact;
  const gt = appTokens(name);
  const known = knownApp(name);
  const wanted = known ? known.names.map(normalizeApp) : [];
  const viaKnown = entries.find((e) => wanted.includes(normalizeApp(e.name)));
  if (viaKnown) return viaKnown;
  return entries
    .filter((e) => wordsWithin(gt, appTokens(e.name)) || (CJK.test(g) && g.length >= 2 && normalizeApp(e.name).includes(g)))
    .sort((a, b) => a.name.length - b.name.length)[0];
}
