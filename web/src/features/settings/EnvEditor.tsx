import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { Icon } from '@/ui/icons';

/** Integrations configured through `env` in ~/.claude/settings.json (provider keys are NOT here: those are per session). */
const ENV_GROUPS: { title: string; keys: { k: string; hint: string; secret?: boolean }[] }[] = [
  { title: 'Web Search', keys: [{ k: 'BRAVE_API_KEY', hint: 'Brave Search API key', secret: true }, { k: 'WEB_SEARCH_PROVIDER', hint: 'api | bing | brave' }] },
  { title: 'Artifacts 上传', keys: [{ k: 'ARTIFACTS_URL', hint: '自托管 Worker 地址，默认官方公共实例' }, { k: 'ARTIFACTS_TOKEN', hint: '上传令牌', secret: true }] },
  { title: 'Langfuse 监控', keys: [{ k: 'LANGFUSE_PUBLIC_KEY', hint: 'pk-lf-…' }, { k: 'LANGFUSE_SECRET_KEY', hint: 'sk-lf-…', secret: true }, { k: 'LANGFUSE_BASE_URL', hint: 'https://cloud.langfuse.com' }] },
  { title: 'Sentry', keys: [{ k: 'SENTRY_DSN', hint: 'https://…@sentry.io/…', secret: true }] },
  { title: '语音（终端 /voice）', keys: [{ k: 'VOICE_PROVIDER', hint: 'doubao …' }, { k: 'VOICE_STREAM_BASE_URL', hint: 'wss://…' }] },
];

type SettingsFile = { path: string; text: string };

/**
 * Edits the `env` block of ~/.claude/settings.json for non-provider integrations. Split out of the old
 * 供应商 / 环境 page (redesign phase 6): settings → 高级 → 环境变量 (`bare`: the page title and lead say what it is),
 * and the dock's 配置中心 → 供应商 / 环境.
 */
export function EnvEditor({ bare = false }: { bare?: boolean }) {
  const [data, setData] = useState<SettingsFile | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    setErr('');
    ws.request<SettingsFile>({ kind: 'config.settings.read', scope: 'user' }).then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [n]);
  useEffect(() => {
    try { const j = JSON.parse(data?.text || '{}'); setEnv(j.env ?? {}); } catch { /* keep */ }
  }, [data]);
  const save = async () => {
    if (!data) return;
    try {
      // merge into what is on disk NOW: `data` is null before the first load (saving then wrote a
      // settings.json containing only `env`) and may be stale if the raw editor saved since
      const fresh = await ws.request<SettingsFile>({ kind: 'config.settings.read', scope: 'user' });
      const j = JSON.parse(fresh.text || '{}');
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (v?.trim()) cleaned[k] = v.trim();
      j.env = { ...(j.env ?? {}), ...cleaned };
      for (const k of Object.keys(j.env)) if (!(k in cleaned) && ENV_GROUPS.some((g) => g.keys.some((x) => x.k === k))) delete j.env[k];
      await ws.request({ kind: 'config.settings.write', scope: 'user', json: JSON.stringify(j, null, 2) });
      setMsg('已保存到 ~/.claude/settings.json，新对话生效');
      setN((x) => x + 1);
    } catch (e: any) { setMsg(e.message); }
  };
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  return (
    <div className="section env-editor">
      {!bare && <h5>其他环境变量</h5>}
      {!bare && <div className="sub" style={{ marginBottom: 8 }}>写入 <code>settings.json</code> 的 <code>env</code>，所有对话生效。留空表示不设置。</div>}
      {ENV_GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 10 }}>
          <h5>{g.title}</h5>
          {g.keys.map(({ k, hint, secret }) => (
            <div key={k} className="env-row">
              <code>{k}</code>
              <input className="field" type={secret && !show[k] ? 'password' : 'text'} placeholder={hint} value={env[k] ?? ''} onChange={(e) => setEnv({ ...env, [k]: e.target.value })} aria-label={k} />
              {secret && <button className="icon-btn" onClick={() => setShow({ ...show, [k]: !show[k] })} aria-label="显示密钥"><Icon name="eye" size={14} /></button>}
            </div>
          ))}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn sm primary" disabled={!data} onClick={save}>保存</button>
        <span className="sub">{msg}</span>
      </div>
    </div>
  );
}
