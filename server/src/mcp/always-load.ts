/**
 * `_meta` for an MCP tool that can answer with a picture: `anthropic/alwaysLoad` keeps the tool in the model's own
 * tool list rather than behind deferred tool search, so the picture arrives as an image block. Only for tools that can
 * return an image: every one of them lengthens each turn's tool list. No imports: the stdio MCP processes load this.
 */
export const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true } as const;
