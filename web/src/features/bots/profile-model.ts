// 值班 Bot 资料栏（spec 2026-10-31 聊天优先 §1 / §7 A）: the pure bits of the profile column. 电脑「最近画面」 in A is
// read off the conversations loaded here — no screenshot channel from the server yet (that is batch B).
import type { Conversation, Item } from '@/model/conversation';

export interface Screen { src: string; at?: number; tool: string }

/** A tool that looks at the screen: the built-in browser's and the computer MCP's. */
const SCREEN_TOOL = /^mcp__(?:web__browser_|computer__)/;

const time = (s: string | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : undefined; };

function scan(items: Item[]): Screen | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant') continue;
    for (let j = it.blocks.length - 1; j >= 0; j--) {
      const b = it.blocks[j];
      if (b.type !== 'tool_use') continue;
      // a sub-agent's calls come after its own call started
      const inner = b.children.length ? scan(b.children) : undefined;
      if (inner) return inner;
      // ccb defers MCP tools behind ExecuteExtraTool: the inner name is the tool
      const name = b.name === 'ExecuteExtraTool' && typeof b.input.tool_name === 'string' ? b.input.tool_name : b.name;
      const imgs = b.result?.images;
      if (!SCREEN_TOOL.test(name) || !imgs?.length) continue;
      return { src: imgs[imgs.length - 1], at: time(b.result?.ts) ?? time(it.ts), tool: name };
    }
  }
  return undefined;
}

/** The newest picture a browser / computer tool returned in a conversation, or undefined. */
export function lastScreen(conv: Conversation | undefined): Screen | undefined {
  return conv ? scan(conv.items) : undefined;
}
