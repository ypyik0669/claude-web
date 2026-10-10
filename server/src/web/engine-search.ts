import { settingsDocs } from '../runtime/user-env.js';

/**
 * The engine's OWN WebSearch tool (claude-web-engine, runtime 'ccb'). It picks its backend from WEB_SEARCH_ADAPTER
 * (`api` | `bing` | `brave` | `exa` | `tavily`), then the `webSearchAdapter` setting, and defaults to `tavily` — a
 * hosted Tavily proxy of the upstream project, which is neither ours nor the user's: every query would pass through
 * it. The user's decision (2026-10-10): no Tavily; searching is done in the built-in browser (the `web` MCP server's
 * `web_search`, web/search.ts). So in the conversations we start on our engine its own WebSearch is taken away
 * (`disallowedTools`) and the model has the one search tool — unless the user chose a backend for it themselves, which
 * is then theirs to use. The official binary is left alone: its WebSearch is Anthropic's server-side tool.
 */
export const ENGINE_SEARCH_TOOL = 'WebSearch';

export function engineSearchOff(o: { engine: 'ccb' | 'claude'; userChoice: boolean }): boolean {
  return o.engine === 'ccb' && !o.userChoice;
}

/**
 * The user picked a backend themselves: WEB_SEARCH_ADAPTER in this process's environment or in the `env` of a
 * settings file the CLI reads, or `webSearchAdapter` in one of those files (the engine's /web-tools panel writes it).
 */
export function userPickedSearchAdapter(cwd?: string, env: Record<string, string | undefined> = process.env, docs: Record<string, unknown>[] = settingsDocs(cwd)): boolean {
  if (env.WEB_SEARCH_ADAPTER) return true;
  return docs.some((d) => {
    const e = d.env;
    return !!d.webSearchAdapter || (!!e && typeof e === 'object' && !!(e as Record<string, unknown>).WEB_SEARCH_ADAPTER);
  });
}
