// The character library's small store (characters.list, kept fresh by characters.changed): what the 后台 · 网吧
// puts on a bot that has a character of its own, and the 角色库 dialog.
import { create } from 'zustand';
import { BUILTIN, type CafeAssign, type CharacterDef, type CharactersList } from '@characters';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { forgetCharacter } from './bake';

interface CafeState {
  list: CharacterDef[];
  byId: Map<string, CharacterDef>;
  assign: CafeAssign;
  loaded: boolean;
  library: boolean;
}

const index = (list: CharacterDef[]) => new Map(list.map((c) => [c.id, c]));

export const useCafe = create<CafeState>(() => ({ list: BUILTIN, byId: index(BUILTIN), assign: {}, loaded: false, library: false }));

/** The bright palette of the agents' colours (tokens.css's dark --agent-1…10): the bots' bodies, day and night. */
export const AGENT_NIGHT = ['#a3e635', '#fbbf24', '#2dd4bf', '#f472b6', '#60a5fa', '#a78bfa', '#fb923c', '#22d3ee', '#e879f9', '#4ade80'];

let installed = false;
async function load() {
  try {
    const r = await ws.request<CharactersList>({ kind: 'characters.list' });
    for (const c of r.characters) if (!c.builtin) forgetCharacter(c.id);
    useCafe.setState({ list: r.characters, byId: index(r.characters), assign: r.assign ?? {}, loaded: true });
  } catch { /* an older server: the built-ins */ }
}

/** Once, in App: load the library when connected, again whenever it changes. */
export function installCafe() {
  if (installed) return;
  installed = true;
  let was = false;
  useStore.subscribe((s) => {
    if (s.connected && !was) void load();
    was = s.connected;
  });
  if (useStore.getState().connected) { was = true; void load(); }
  ws.on((e: any) => { if (e?.kind === 'characters.changed') void load(); });
}

export const openLibrary = () => useCafe.setState({ library: true });
export const closeLibrary = () => useCafe.setState({ library: false });
