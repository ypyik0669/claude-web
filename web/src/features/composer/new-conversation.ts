// A new conversation opened anywhere but the start page — the sidebar's ＋ and 在这里新建对话 (projects, folders, a
// worktree), the Git view's worktrees, the board, a task chip — starts where the start page would start it: on its last
// agent / provider / model with the same fallbacks (startPick), and with the same 「先接一个模型」 when that would be the
// Claude account while it is logged out. These used to open with nothing, and the server put them on the account: with
// only relays set up (no default provider) the new conversation said 「这个对话没有能用的模型来源」 and its chip showed
// the account's model until one was picked by hand (2026-11-21, packaged build).
import type { Provider } from '@shared';
import { useStore } from '@/store';
import { connectModel, type ConnectReason } from '@/features/providers/ConnectModel';
import { usableProfile } from '@/features/models/menu';
import { gatewayNow, providersLoaded } from '@/features/models/data';
import { needsModel, startPick, type LastStart, type StartPick } from './welcome-provider';

/** What the start page's send remembered (the keys the composer reads and writes); storage blocked = nothing. */
export function readLastStart(): LastStart {
  const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  return { provider: get('cw.lastProvider'), model: get('cw.lastModel'), agent: get('cw.lastAgent') };
}

/** The providers an agent can use right now, in list order (the model menu's own check). */
export function usableProviderIds(providers: Provider[], i: Parameters<typeof usableProfile>[2]): string[] {
  return providers.filter((p) => usableProfile(providers, p.id, i)).map((p) => p.id);
}

/**
 * Starting on `pick` would go out on the Claude account while it is known to be logged out (it would only answer
 * 「Not logged in」): connect a model first — or pick one already added — and start on that, on its own default model.
 * Null = the dialog was closed: start nothing. The start page's send asks through here too.
 */
export async function withUsableModel(pick: StartPick, reason: ConnectReason): Promise<StartPick | null> {
  if (!needsModel({ provider: pick.providerId, foreignAgent: !!pick.agent && pick.agent !== 'claude', loggedIn: useStore.getState().auth?.loggedIn })) return pick;
  const p = await connectModel({ reason });
  return p ? { ...pick, providerId: p.id, model: undefined } : null;
}

/** What a new conversation opened outside the start page starts on; null = a model was needed and the dialog was closed. */
export async function newConversationPick(reason: ConnectReason = 'new'): Promise<StartPick | null> {
  const last = readLastStart();
  // the lists arrive after the first paint: a click before them must not read 「no provider」 / 「no such agent」
  const first = useStore.getState();
  if (!providersLoaded(first.providers)) await first.loadProviders().catch(() => {});
  if (last.agent && last.agent !== 'claude' && !first.agents.length) await first.loadAgents().catch(() => {});
  const st = useStore.getState();
  const gw = gatewayNow();
  const ctx = { engine: st.engine, gatewayGroups: gw.groups, gatewayEnabled: gw.enabled };
  const pick = startPick({
    last,
    def: st.settings.defaultProviderId as string | undefined,
    loggedIn: st.auth?.loggedIn,
    usable: usableProviderIds(st.providers, { agent: 'claude', ...ctx }),
    agents: st.agents.map((a) => a.kind),
    usableFor: (agent, id) => !!usableProfile(st.providers, id, { agent, ...ctx }),
  });
  return withUsableModel(pick, reason);
}

/**
 * A new conversation in `cwd` (placed like openSession places one: in the focused pane) on newConversationPick.
 * `send` when a message goes out in it right away (the dialog then says that message is sent). Null = nothing opened.
 */
export async function openNewConversation(p: { cwd: string; worktree?: string }, reason: ConnectReason = 'new'): Promise<string | null> {
  const pick = await newConversationPick(reason);
  return pick ? useStore.getState().openSession({ ...p, ...pick }) : null;
}
