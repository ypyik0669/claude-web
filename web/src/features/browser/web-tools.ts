// The web tools as a conversation shows them (server/src/web/mcp.ts: the MCP server `web`): a step's verb and target,
// and what a permission card asks. Pure.
import type { IconName } from '@/ui/icons';

export const WEB_TOOLS = ['web_search', 'browser_open', 'browser_read', 'browser_find', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_back', 'browser_screenshot'] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

/** `mcp__web__browser_open` (Claude), `web__browser_open` / `web.browser_open` / the bare name (other agents) → the tool. */
export function webToolOf(name: string): WebTool | null {
  const bare = name.replace(/^mcp__web__/, '').replace(/^web(__|\.|\/)/, '');
  if (bare === name && !name.startsWith('browser_')) return null; // a bare `web_search` is someone else's tool
  return (WEB_TOOLS as readonly string[]).includes(bare) ? (bare as WebTool) : null;
}

const str = (i: Record<string, unknown> | undefined, k: string) => (typeof i?.[k] === 'string' ? (i[k] as string) : '');
/** `github.com/a/b` for an address: what a row has room for (the tooltip has all of it). */
export function shortAddress(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host.replace(/^www\./i, '')}${path}${u.search ? '?…' : ''}`;
  } catch { return url; }
}
const host = (url: string) => { try { return new URL(url).host.replace(/^www\./i, ''); } catch { return ''; } };

export interface WebToolLabel { icon: IconName; verb: string; arg: string }

export function webToolLabel(tool: WebTool, input: Record<string, unknown> | undefined): WebToolLabel {
  switch (tool) {
    case 'web_search': return { icon: 'search', verb: '搜索网页:', arg: str(input, 'query') };
    case 'browser_open': return { icon: 'web', verb: '打开网页:', arg: shortAddress(str(input, 'url')) };
    case 'browser_read': return { icon: 'web', verb: '读网页', arg: Number(input?.offset) > 0 ? `从第 ${Number(input?.offset)} 个字符` : '' };
    case 'browser_find': return { icon: 'search', verb: '在网页里找:', arg: str(input, 'query') };
    case 'browser_click': return { icon: 'cursor', verb: '点击网页:', arg: refText(input?.ref) };
    case 'browser_type': return { icon: 'keyboard', verb: '在网页里输入:', arg: `${str(input, 'text').slice(0, 80)}${input?.submit === true ? ' ↵' : ''}` };
    case 'browser_press_key': return { icon: 'keyboard', verb: '按键:', arg: str(input, 'key') };
    case 'browser_scroll': return { icon: 'web', verb: input?.direction === 'up' ? '向上滚动网页' : '向下滚动网页', arg: '' };
    case 'browser_back': return { icon: 'web', verb: '返回上一页', arg: '' };
    case 'browser_screenshot': return { icon: 'image', verb: '给网页截图', arg: '' };
  }
}
const refText = (ref: unknown) => (typeof ref === 'string' || typeof ref === 'number' ? `[${String(ref).replace(/^\[|\]$/g, '')}]` : '');

/** 「Claude 想在浏览器里打开 github.com」: what a permission card asks for a web tool. */
export function webToolAsk(tool: WebTool, input: Record<string, unknown> | undefined, agent: string): string {
  switch (tool) {
    case 'web_search': return `${agent} 想搜索网页`;
    case 'browser_open': { const h = host(str(input, 'url')); return h ? `${agent} 想在浏览器里打开 ${h}` : `${agent} 想在浏览器里打开一个网页`; }
    case 'browser_read': return `${agent} 想读浏览器里的网页`;
    case 'browser_find': return `${agent} 想在网页里查找`;
    case 'browser_click': return `${agent} 想在网页上点一下`;
    case 'browser_type': return input?.submit === true ? `${agent} 想在网页上输入并提交` : `${agent} 想在网页上输入文字`;
    case 'browser_press_key': return `${agent} 想在网页上按键`;
    case 'browser_scroll': return `${agent} 想滚动网页`;
    case 'browser_back': return `${agent} 想让网页返回上一页`;
    case 'browser_screenshot': return `${agent} 想给网页截图`;
  }
}
