import { useEffect, useState } from 'react';
import type { WebSearchAnswer, WebStatus } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { imeComposing } from '@/ui/ime';
import { Icon } from '@/ui/icons';
import { Row } from '@/features/settings/controls';
import { showPanel } from '@/features/workbench/right-panel';
import './browser.css';

/** The search services that need a key of their own → the setting it is kept in (protected on the server, never sent back). */
const KEY_SETTING: Record<string, string> = { brave: 'web.search.braveKey' };

/**
 * 设置 → 联网 (spec 2026-10-10-ui-structure §5): whether Agents get the web tools at all, what searches for them, and
 * whose logins the pages they open carry. The status comes from the server (`web.status`), which also keeps the keys.
 */
export function WebSettings() {
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);
  const [st, setSt] = useState<WebStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<(WebSearchAnswer & { weak?: boolean }) | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState('');

  const load = () => ws.request<WebStatus>({ kind: 'web.status' }).then(setSt).catch(() => {});
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'web.changed') void load(); }); return () => { off(); }; }, []);

  const set = async (k: string, v: unknown) => { try { await setSetting(k, v); await load(); } catch (e) { toast((e as Error).message); } };
  const current = st?.engines.find((e) => e.id === st.engine);
  const keySetting = current?.needsKey ? KEY_SETTING[current.id] : undefined;
  const saveKey = async (value: string) => {
    if (!keySetting) return;
    setBusy(true);
    // straight to the server: the key is never kept in this window's copy of the settings
    try { await ws.request({ kind: 'settings.set', key: keySetting, value }); setKey(''); await load(); toast(value ? '密钥已保存' : '密钥已删除', true); } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };
  const search = async () => {
    const query = q.trim();
    if (!query || searching) return;
    setSearching(true);
    setErr('');
    try { setFound(await ws.request<WebSearchAnswer>({ kind: 'web.search', query, count: 5 })); } catch (e) { setFound(null); setErr((e as Error).message); }
    setSearching(false);
  };
  const label = (id: string) => st?.engines.find((e) => e.id === id)?.label ?? id;

  return (
    <>
      <div className="section" data-id="web-agents">
        <h5>Agent 上网</h5>
        <Row label="让 Agent 能搜索和打开网页" hint="每个对话里的 Agent 多出「搜索」和「浏览器」两类工具，Claude、Codex、Gemini 都一样。改动对之后新开的对话生效。">
          <button className={clsx('toggle', st?.enabled && 'on')} role="switch" aria-checked={!!st?.enabled} aria-label="让 Agent 能搜索和打开网页" disabled={!st} data-id="web-on" onClick={() => void set('web.mcp', !st?.enabled)} />
        </Row>
        <Row label="用什么搜索" hint={st && !st.host
          ? '现在没有桌面窗口连着（网页版、手机）：只能由这台电脑直接去抓 Bing 和 DuckDuckGo 的结果页，容易被限流；Google、Yahoo、百度要桌面版的内置浏览器。'
          : '搜索是在内置浏览器里做的：打开搜索网站的结果页，把结果读出来，不用密钥。自动 = 依次试 DuckDuckGo、Bing、Yahoo、百度，哪个给出对题的结果就用哪个。哪一家能用和你的网络有关，用下面的「试一下」看看。'}>
          <select className="field" aria-label="用什么搜索" data-id="web-search" disabled={!st} value={st?.engine ?? 'auto'} onChange={(e) => void set('web.search.engine', e.target.value)}>
            {(st?.engines ?? []).map((e) => <option key={e.id} value={e.id}>{e.label}{e.browser && !st?.host ? '（要桌面版）' : ''}</option>)}
          </select>
        </Row>
        {current?.needsKey && (
          <Row label="Brave Search 的密钥" hint={current.hasKey ? '已经保存在这台电脑上（加密）。填一个新的会替换它。' : '保存在这台电脑上（加密），只在搜索时发给这家服务。'}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="field" type="password" style={{ width: 220 }} autoComplete="off" placeholder={current.hasKey ? '••••••（已保存）' : '粘贴密钥'} aria-label="Brave Search 的密钥" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && key.trim()) void saveKey(key.trim()); }} />
              <button className="btn sm" disabled={busy || !key.trim()} onClick={() => void saveKey(key.trim())}>保存</button>
              {current.hasKey && <button className="btn sm ghost" disabled={busy} onClick={() => void saveKey('')}>删除</button>}
            </div>
          </Row>
        )}
        <Row label="试一下" hint="用上面选的搜一次，看看在你的网络下搜不搜得到。某个搜索网站要求验证时，在右侧面板的浏览器里打开它、验证一次，之后就能搜了。">
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="field" style={{ width: 220 }} placeholder="随便搜点什么" aria-label="试着搜索" data-id="web-try" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) void search(); }} />
            <button className="btn sm" disabled={searching || !q.trim()} onClick={() => void search()}>{searching ? '搜索中…' : '搜索'}</button>
          </div>
        </Row>
        {err && <div className="sub" style={{ color: 'var(--err)', marginTop: 6 }} role="alert">没有搜到：{err}</div>}
        {found && (
          <div className="web-found" data-id="web-found">
            <div className="sub">{found.results.length ? `${label(found.engine)} 找到 ${found.results.length} 条` : `${label(found.engine)} 没有找到结果`}{found.weak ? '（和搜索词只对上了一部分）' : ''}</div>
            {found.results.map((r) => (
              <div key={r.url} className="web-hit">
                <span className="t">{r.title}</span>
                <span className="u">{r.url}</span>
                {r.snippet && <span className="s">{r.snippet}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section" data-id="web-browser">
        <h5>内置浏览器</h5>
        <Row label="Agent 在哪里打开网页" hint={st?.host ? '在桌面窗口右侧面板的「浏览器」里，每个对话的 Agent 各用一个标签页，你看得到它在做什么。' : '现在没有桌面窗口连着（网页版、手机）：Agent 只能读网页上的文字，点击、填表和截图要桌面版。'}>
          <button className="btn sm" onClick={() => { useStore.setState({ settingsOpen: null }); showPanel('browser'); }}><Icon name="web" size={13} /> 打开浏览器</button>
        </Row>
        <Row label="Agent 用单独的浏览器身份" hint="关着：Agent 打开的网页带着你在内置浏览器里登录过的账号。打开：它用单独的一份，你登录过的网站对它来说都没登录。对之后新开的 Agent 标签页生效。">
          <button className={clsx('toggle', st?.isolated && 'on')} role="switch" aria-checked={!!st?.isolated} aria-label="Agent 用单独的浏览器身份" disabled={!st} data-id="web-isolated" onClick={() => void set('web.browser.isolated', !st?.isolated)} />
        </Row>
      </div>
    </>
  );
}
