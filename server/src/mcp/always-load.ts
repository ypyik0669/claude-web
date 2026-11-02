/**
 * `_meta` for an MCP tool that can answer with a picture. Our engine (the ccb fork) defers MCP tools behind
 * ExecuteExtraTool, and that runner hands the result back to the model as one JSON string — a screenshot would reach
 * the model as base64 text it cannot see. `anthropic/alwaysLoad` keeps the tool in the model's own tool list, so the
 * picture arrives as an image block. Only for tools that can return an image, and web_search (the tool a research
 * agent reaches for first): every one of them lengthens each turn's tool list. (The official binary loads them either
 * way.) No imports: the stdio MCP processes load this.
 */
export const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true } as const;
