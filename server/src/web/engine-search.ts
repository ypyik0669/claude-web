import { settingsDocs } from '../runtime/user-env.js';

/**
 * The engine's OWN WebSearch tool (claude-web-engine, runtime 'ccb'). It picks its backend from WEB_SEARCH_ADAPTER
 * (`api` | `bing` | `brave` | `exa` | `tavily`), then the `webSearchAdapter` setting, and defaults to `tavily` — a
 * hosted Tavily proxy of the upstream project, which is neither ours nor the user's. We set the variable for the
 * conversations we start, unless the user chose one themselves:
 *  - a provider conversation, or the account when it is really a relay from settings.json → `bing` (the engine
 *    fetches Bing's result page itself; no key, and it goes through the proxy the CLI was given);
 *  - the account on claude.ai → `api`: Anthropic's server-side web_search tool, a second request through the same
 *    login — what the official Claude Code does. Third-party endpoints do not implement that tool.
 * The official binary is left alone: it has one way (the server-side tool) and no such variable.
 */
export type EngineSearchAdapter = 'api' | 'bing';

export function engineSearchAdapter(o: { engine: 'ccb' | 'claude'; provider: boolean; relay: boolean; userChoice: boolean }): EngineSearchAdapter | undefined {
  if (o.engine !== 'ccb' || o.userChoice) return undefined;
  return o.provider || o.relay ? 'bing' : 'api';
}

/**
 * The user picked a backend themselves: WEB_SEARCH_ADAPTER in this process's environment or in the `env` of a
 * settings file the CLI reads (which would be laid over ours anyway), or `webSearchAdapter` in one of those files
 * (the engine's /web-tools panel writes it; the variable would override it).
 */
export function userPickedSearchAdapter(cwd?: string, env: Record<string, string | undefined> = process.env, docs: Record<string, unknown>[] = settingsDocs(cwd)): boolean {
  if (env.WEB_SEARCH_ADAPTER) return true;
  return docs.some((d) => {
    const e = d.env;
    return !!d.webSearchAdapter || (!!e && typeof e === 'object' && !!(e as Record<string, unknown>).WEB_SEARCH_ADAPTER);
  });
}
