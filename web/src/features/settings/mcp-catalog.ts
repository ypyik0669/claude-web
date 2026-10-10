// The connector directory's data: popular MCP servers with ready-to-use configs. Pure (no store, no React) — the
// settings page's list (McpCatalog.tsx) and the 扩展 page's directory (features/extensions/) both draw it.
export interface CatalogItem { id: string; name: string; desc: string; cat: string; json: Record<string, unknown>; env?: string[]; oauth?: boolean }

// Curated list modelled on Mirasim's MCP directory: popular stdio / http servers with ready-to-use configs.
export const MCP_CATALOG: CatalogItem[] = [
  { id: 'filesystem', name: 'Filesystem', desc: '读写指定目录', cat: '本地', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
  { id: 'memory', name: 'Memory', desc: '知识图谱式长期记忆', cat: '本地', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
  { id: 'sequential-thinking', name: 'Sequential Thinking', desc: '逐步推理', cat: '本地', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } },
  { id: 'fetch', name: 'Fetch', desc: '抓网页转 markdown', cat: '网络', json: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] } },
  { id: 'puppeteer', name: 'Puppeteer', desc: '无头浏览器自动化', cat: '网络', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] } },
  { id: 'playwright', name: 'Playwright', desc: '微软官方浏览器自动化', cat: '网络', json: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  { id: 'brave-search', name: 'Brave Search', desc: '网页搜索', cat: '网络', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] }, env: ['BRAVE_API_KEY'] },
  { id: 'exa', name: 'Exa', desc: 'AI 搜索', cat: '网络', json: { type: 'http', url: 'https://mcp.exa.ai/mcp' } },
  { id: 'context7', name: 'Context7', desc: '最新库文档', cat: '开发', json: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  { id: 'github', name: 'GitHub', desc: '仓库 / issue / PR', cat: '开发', json: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }, oauth: true },
  { id: 'gitlab', name: 'GitLab', desc: '项目 / MR / issue', cat: '开发', json: { type: 'stdio', command: 'npx', args: ['-y', '@zereight/mcp-gitlab'] }, env: ['GITLAB_API_URL', 'GITLAB_PERSONAL_ACCESS_TOKEN'] },
  { id: 'sentry', name: 'Sentry', desc: '错误监控', cat: '开发', json: { type: 'http', url: 'https://mcp.sentry.dev/mcp' }, oauth: true },
  { id: 'linear', name: 'Linear', desc: '任务管理', cat: '协作', json: { type: 'sse', url: 'https://mcp.linear.app/sse' }, oauth: true },
  { id: 'notion', name: 'Notion', desc: '页面 / 数据库', cat: '协作', json: { type: 'http', url: 'https://mcp.notion.com/mcp' }, oauth: true },
  { id: 'atlassian', name: 'Atlassian (Jira / Confluence)', desc: 'Jira 与 Confluence', cat: '协作', json: { type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' }, oauth: true },
  { id: 'slack', name: 'Slack', desc: '读写频道消息', cat: '协作', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] }, env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'] },
  { id: 'figma', name: 'Figma', desc: '设计稿转代码', cat: '设计', json: { type: 'http', url: 'https://mcp.figma.com/mcp' }, oauth: true },
  { id: 'postgres', name: 'PostgreSQL', desc: '只读查询', cat: '数据', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'] } },
  { id: 'sqlite', name: 'SQLite', desc: '本地数据库', cat: '数据', json: { type: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', './data.db'] } },
  { id: 'supabase', name: 'Supabase', desc: '项目 / 表 / SQL', cat: '数据', json: { type: 'http', url: 'https://mcp.supabase.com/mcp' }, oauth: true },
  { id: 'stripe', name: 'Stripe', desc: '支付 API', cat: '服务', json: { type: 'http', url: 'https://mcp.stripe.com' }, oauth: true },
  { id: 'cloudflare', name: 'Cloudflare', desc: 'Workers / KV / R2', cat: '服务', json: { type: 'sse', url: 'https://bindings.mcp.cloudflare.com/sse' }, oauth: true },
  { id: 'vercel', name: 'Vercel', desc: '部署 / 项目', cat: '服务', json: { type: 'http', url: 'https://mcp.vercel.com' }, oauth: true },
  { id: 'aws-docs', name: 'AWS Docs', desc: 'AWS 文档检索', cat: '服务', json: { type: 'stdio', command: 'uvx', args: ['awslabs.aws-documentation-mcp-server@latest'] } },
  { id: 'docker', name: 'Docker', desc: '容器 / 镜像', cat: '本地', json: { type: 'stdio', command: 'uvx', args: ['docker-mcp'] } },
  { id: 'time', name: 'Time', desc: '时区换算', cat: '本地', json: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] } },
  { id: 'everything', name: 'Everything (测试)', desc: '演示所有 MCP 能力', cat: '本地', json: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } },
];
