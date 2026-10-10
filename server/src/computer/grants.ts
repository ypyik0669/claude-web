/**
 * Who may the agent touch? — the applications the user approved in this process, and the gate every tool goes through.
 *
 * The host shows the user a permission prompt for every `request_access` call and lets the other tools through, so a
 * `request_access` that reaches this server is the user's yes. Everything else is decided here, from what is in front
 * of the user right now:
 *
 *  - before the first grant nothing is captured and nothing is sent;
 *  - input (clicks, drags, scrolling, typing, keys) needs the app in front to be granted — and, for anything aimed at
 *    a point, the window under that point too: a click lands on what is under the pointer, not on what is in front;
 *  - Claude Web itself is never a target, whatever was granted: the agent must not be able to press its own approval
 *    buttons.
 *
 * Pure: the caller hands in what the Windows helper saw.
 */
import { describeApp, grantCovers, knownApp, normalizeApp, sameExe, type WindowApp } from './apps.js';

export interface Grant {
  /** as the agent asked for it */
  name: string;
  /** normalizeApp(name) — one grant per spelling */
  key: string;
}

export interface GrantFlags { clipboardRead: boolean; clipboardWrite: boolean; systemKeyCombos: boolean }

/** How to recognise the app this server belongs to. */
export interface SelfId {
  /** CW_COMPUTER_SELF_EXE: the desktop app's executable, when there is one */
  exe?: string;
}

/** The web version runs in the user's browser: its tab carries this title, and so does the desktop window. */
export const SELF_TITLE = 'Claude Web';
const SELF_KEY = normalizeApp(SELF_TITLE);

/** A name that asks for Claude Web itself ("Claude Web", "claude-web", "Claude Web.exe"). */
export function namesSelf(name: string): boolean {
  return normalizeApp(name).includes(SELF_KEY);
}

/** Is this window Claude Web — the desktop app's own executable, or any window titled like it? */
export function isSelf(app: Pick<WindowApp, 'exe' | 'title'> | null | undefined, self: SelfId): boolean {
  if (!app) return false;
  if (sameExe(app.exe, self.exe)) return true;
  return String(app.title ?? '').toLowerCase().includes(SELF_TITLE.toLowerCase());
}

export class Grants {
  private readonly list = new Map<string, Grant>();
  readonly flags: GrantFlags = { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false };

  /** Add an approved name. False: it names Claude Web, or nothing at all. */
  add(name: string): boolean {
    const key = normalizeApp(name);
    if (!key || namesSelf(name)) return false;
    if (!this.list.has(key)) this.list.set(key, { name: name.trim(), key });
    return true;
  }

  any(): boolean { return this.list.size > 0; }
  names(): string[] { return [...this.list.values()].map((g) => g.name); }

  /** The grant that covers this app, if one does. */
  covering(app: Pick<WindowApp, 'name' | 'description' | 'product'> | null | undefined): Grant | undefined {
    if (!app) return undefined;
    for (const g of this.list.values()) if (grantCovers(g.name, app)) return g;
    return undefined;
  }

  /**
   * The grant a name refers to (open_application): the same spelling, or another name of the same known app —
   * "记事本" after "Notepad" was granted.
   */
  named(name: string): Grant | undefined {
    const key = normalizeApp(name);
    if (!key) return undefined;
    const direct = this.list.get(key);
    if (direct) return direct;
    const known = knownApp(name);
    if (!known) return undefined;
    for (const g of this.list.values()) if (knownApp(g.name) === known) return g;
    return undefined;
  }
}

/** What a tool needs before it runs. */
export type Need =
  /** nothing: request_access, list_granted_applications, wait */
  | 'none'
  /** at least one granted app: looking (screenshot, zoom, cursor), moving the pointer, reading the clipboard */
  | 'grant'
  /** the app in front granted (and the window under each target point): everything that sends input */
  | 'input';

export const TOOL_NEEDS: Record<string, Need> = {
  request_access: 'none',
  list_granted_applications: 'none',
  wait: 'none',
  open_application: 'grant',
  screenshot: 'grant',
  zoom: 'grant',
  cursor_position: 'grant',
  mouse_move: 'grant',
  read_clipboard: 'grant',
  left_click: 'input',
  right_click: 'input',
  middle_click: 'input',
  double_click: 'input',
  triple_click: 'input',
  left_click_drag: 'input',
  left_mouse_down: 'input',
  left_mouse_up: 'input',
  scroll: 'input',
  type: 'input',
  key: 'input',
  hold_key: 'input',
  write_clipboard: 'input',
  computer_batch: 'none', // each action inside goes through its own gate
};

/** The tools that put input into the machine (the rest only look, wait or manage access). */
export const INPUT_TOOLS = Object.keys(TOOL_NEEDS).filter((t) => TOOL_NEEDS[t] === 'input');

/** What the helper saw just before an action. */
export interface Seen {
  /** the window in front; null when Windows reports none (between two windows, a locked screen) */
  fg: WindowApp | null;
  /** for an action aimed at points: the top-level window under each, in the caller's order */
  under?: Array<{ at: string; app: WindowApp | null }>;
}

export type Verdict = { ok: true } | { ok: false; reason: 'no-grant' | 'no-foreground' | 'self' | 'not-granted'; text: string };

export const NO_GRANT_TEXT = 'No application access yet. Call request_access first with the applications you need (the user approves it); nothing is captured or sent before that.';

const refuse = (reason: Exclude<Verdict, { ok: true }>['reason'], text: string): Verdict => ({ ok: false, reason, text });

function grantedList(grants: Grants): string {
  const names = grants.names();
  return names.length ? ` Granted: ${names.join(', ')}.` : '';
}

/** May this go ahead? `seen` is only looked at for 'input'. */
export function gate(need: Need, grants: Grants, seen: Seen | null, self: SelfId): Verdict {
  if (need === 'none') return { ok: true };
  if (!grants.any()) return refuse('no-grant', NO_GRANT_TEXT);
  if (need === 'grant') return { ok: true };

  const fg = seen?.fg ?? null;
  if (!fg) {
    return refuse('no-foreground', 'No window is in front right now (the screen may be locked, or a window is just opening), so nothing was sent. Take a screenshot, or bring a granted application forward with open_application.');
  }
  if (isSelf(fg, self)) {
    return refuse('self', 'Claude Web itself is in front, and this server never sends input to it — the user answers its prompts themselves. Nothing was sent. Bring a granted application forward with open_application.');
  }
  if (!grants.covering(fg)) {
    return refuse('not-granted', `${describeApp(fg)} is in front and is not a granted application, so nothing was sent. Call request_access for it, or bring a granted application forward with open_application.${grantedList(grants)}`);
  }
  for (const u of seen?.under ?? []) {
    if (!u.app) return refuse('not-granted', `There is no window at ${u.at}, so nothing was sent. Take a screenshot and aim at a granted application.`);
    if (isSelf(u.app, self)) {
      return refuse('self', `${u.at} is on Claude Web's own window, and this server never sends input to it. Nothing was sent.`);
    }
    if (!grants.covering(u.app)) {
      return refuse('not-granted', `${u.at} is over ${describeApp(u.app)}, which is not a granted application, so nothing was sent. Call request_access for it, or aim at a granted application.${grantedList(grants)}`);
    }
  }
  return { ok: true };
}
