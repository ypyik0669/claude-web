import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useScopedSession, useStore } from '@/store';
import { clsx } from '@/util';
import type { McpHealth, RegistryServer } from '@shared';
import { dlg } from '@/ui/dialog';
import { mcpChanged, useMcpChanged } from '@/features/panels/ConfigPanel';

interface CatalogItem { id: string; name: string; desc: string; cat: string; json: Record<string, unknown>; env?: string[]; oauth?: boolean }

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

/** Catalog + official registry search + health check; installs through `claude mcp add-json`. */
export function McpCatalog() {
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('全部');
  const [reg, setReg] = useState<RegistryServer[] | null>(null);
  const [regBusy, setRegBusy] = useState(false);
  const [health, setHealth] = useState<McpHealth[] | null>(null);
  const [hBusy, setHBusy] = useState(false);
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [installed, setInstalled] = useState<string[]>([]);
  const cwd = active?.cwd;
  const cats = ['全部', ...new Set(MCP_CATALOG.map((c) => c.cat))];
  const reloadInstalled = () => ws.request<{ servers: any[] }>({ kind: 'config.mcp' }).then((r) => setInstalled((r.servers ?? []).map((s: any) => s.name))).catch(() => {});
  useEffect(() => { void reloadInstalled(); }, []);
  useMcpChanged(() => void reloadInstalled()); // the list above / the JSON form added or removed one
  const install = async (name: string, json: Record<string, unknown>, env?: string[], oauth?: boolean) => {
    let cfg = { ...json } as any;
    if (env?.length) {
      const vals: Record<string, string> = {};
      for (const k of env) { const v = await dlg.prompt(`${name} 需要 ${k}`, '', { placeholder: k }); if (v === null) return; if (v) vals[k] = v; }
      if (Object.keys(vals).length) cfg = { ...cfg, env: vals };
    }
    try {
      await ws.request({ kind: 'config.mcp.add', name, json: JSON.stringify(cfg), scope, cwd });
      toast(`已添加 ${name}${oauth ? '，首次使用在对话里输入 /mcp 完成 OAuth 授权' : ''}`, true);
      mcpChanged();
    } catch (e: any) { toast(e.message); }
  };
  const searchRegistry = async () => {
    setRegBusy(true);
    try { setReg(await ws.request<RegistryServer[]>({ kind: 'mcp.registry', query: q })); } catch (e: any) { toast(`注册表：${e.message}`); setReg([]); }
    setRegBusy(false);
  };
  const checkHealth = async () => {
    setHBusy(true);
    try { setHealth(await ws.request<McpHealth[]>({ kind: 'mcp.health', cwd })); } catch (e: any) { toast(e.message); }
    setHBusy(false);
  };
  const ql = q.trim().toLowerCase();
  const items = MCP_CATALOG.filter((c) => (cat === '全部' || c.cat === cat) && (!ql || `${c.name} ${c.desc} ${c.id}`.toLowerCase().includes(ql)));
  return (
    <>
      <div className="section">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <input className="field" style={{ flex: 1 }} placeholder="筛选目录，或搜索官方注册表…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchRegistry()} />
          <select className="field" value={scope} onChange={(e) => setScope(e.target.value as any)} title="安装到哪个范围">
            <option value="user">用户级</option>
            <option value="project" disabled={!cwd}>项目 .mcp.json</option>
            <option value="local" disabled={!cwd}>本项目（仅本机）</option>
          </select>
          <button className="btn sm" disabled={regBusy} onClick={searchRegistry}>{regBusy ? '搜索中…' : '搜注册表'}</button>
          <button className="btn sm ghost" disabled={hBusy} onClick={checkHealth}>{hBusy ? '检查中…' : '健康检查'}</button>
        </div>
        {health && (
          <div className="list" style={{ marginBottom: 8 }}>
            {health.map((h) => <div key={h.name} className="row"><span className={clsx('dot', h.status === 'connected' ? 'idle' : h.status === 'needs-auth' ? 'waiting' : 'error')} /><div className="grow"><div>{h.name}</div><div className="sub">{h.detail}</div></div>{h.status === 'needs-auth' && <span className="badge">对话里 /mcp 授权</span>}</div>)}
            {!health.length && <div className="empty">没有配置 MCP 服务器</div>}
          </div>
        )}
        <div className="chips" style={{ marginBottom: 6 }}>{cats.map((c) => <button key={c} className={clsx('chip', cat === c && 'active')} onClick={() => setCat(c)}>{c}</button>)}</div>
        <div className="mcp-grid">
          {items.map((c) => (
            <div key={c.id} className="mcp-card">
              <div className="t">{c.name} {c.oauth && <span className="badge" title="需要 OAuth 授权">OAuth</span>}{installed.includes(c.id) && <span className="badge ok">已装</span>}</div>
              <div className="d">{c.desc}</div>
              <div className="m mono">{(c.json as any).type} · {(c.json as any).command ? `${(c.json as any).command} ${((c.json as any).args ?? []).join(' ')}` : (c.json as any).url}</div>
              <div className="a"><button className="btn sm" disabled={installed.includes(c.id)} onClick={() => install(c.id, c.json, c.env, c.oauth)}>{installed.includes(c.id) ? '已安装' : '安装'}</button></div>
            </div>
          ))}
        </div>
        {reg && (
          <>
            <h5 style={{ marginTop: 10 }}>注册表结果（{reg.length}）</h5>
            <div className="list">
              {reg.map((r) => (
                <div key={r.name} className="row">
                  <div className="grow">
                    <div>{r.name} <span className="badge">{r.kind}</span></div>
                    <div className="sub">{r.description}</div>
                    {r.install && <div className="sub mono">{r.install.command ? `${r.install.command} ${(r.install.args ?? []).join(' ')}` : r.install.url}</div>}
                  </div>
                  {r.repo && <a className="btn sm ghost" href={r.repo} target="_blank" rel="noreferrer">仓库</a>}
                  <button className="btn sm" disabled={!r.install} onClick={() => r.install && install(r.name.split('/').pop()!.replace(/[^\w.-]/g, '-'), r.install.command ? { type: 'stdio', command: r.install.command, args: r.install.args } : { type: r.install.transport, url: r.install.url }, r.install.env)}>安装</button>
                </div>
              ))}
              {!reg.length && <div className="empty">没有结果</div>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
