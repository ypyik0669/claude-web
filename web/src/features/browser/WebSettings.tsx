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
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';
import { COOKIES_KEY, COOKIE_MODES, cookieModeText, cookiesMode } from './state';
import { ALLOWED_SITES_KEY, AllowedSites, readSites } from './AllowedSites';
import { openExternal } from '@/features/chat/link-route';

const EGO_URL = 'https://lite.ego.app/';

/** The search services that need a key of their own → the setting it is kept in (protected on the server, never sent back). */
const KEY_SETTING: Record<string, string> = { brave: 'web.search.braveKey' };

/**
 * The search choices' names in the page's language: the server's labels are read once in its own process's language
 * (server/src/web/search.ts ENGINES), which need not be the page's. Ids not here keep the server's label.
 */
const ENGINE_LABEL: Record<string, string> = {
  auto: tr('自动（DuckDuckGo → Bing → Yahoo → 百度）'),
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  google: 'Google',
  yahoo: 'Yahoo',
  baidu: tr('百度'),
  brave: tr('Brave Search（API，要密钥）'),
};
export const engineChoiceLabel = (e: { id: string; label: string }): string => ENGINE_LABEL[e.id] ?? e.label;

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
  // 保留 Cookie: web.browser.cookies, else the old web.browser.isolated (state.ts cookiesMode)
  const storedMode = useStore((s) => s.settings[COOKIES_KEY]);
  const oldIsolated = useStore((s) => s.settings['web.browser.isolated']);
  const cookieMode = cookiesMode({ [COOKIES_KEY]: storedMode, 'web.browser.isolated': oldIsolated });
  // 允许的网站: the stored array (stable reference), counted here; listed and removed in AllowedSites
  const storedSites = useStore((s) => s.settings[ALLOWED_SITES_KEY]);
  const sites = readSites(storedSites);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const detect = async () => {
    setDetecting(true);
    try { setSt(await ws.request<WebStatus>({ kind: 'web.egoDetect' })); } catch (e) { toast((e as Error).message); }
    setDetecting(false);
  };

  const load = () => ws.request<WebStatus>({ kind: 'web.status' }).then(setSt).catch(() => {});
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'web.changed') void load(); }); return () => { off(); }; }, []);

  const set = async (k: string, v: unknown) => { try { await setSetting(k, v); await load(); } catch (e) { toast((e as Error).message); } };
  const current = st?.engines.find((e) => e.id === st.engine);
  const keySetting = current?.needsKey ? KEY_SETTING[current.id] : undefined;
  const saveKey = async (value: string) => {
    if (!keySetting) return;
    setBusy(true);
    // straight to the server: the key is never kept in this window's copy of the settings
    try { await ws.request({ kind: 'settings.set', key: keySetting, value }); setKey(''); await load(); toast(value ? tr('密钥已保存') : tr('密钥已删除'), true); } catch (e) { toast((e as Error).message); }
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
  const label = (id: string) => { const e = st?.engines.find((x) => x.id === id); return e ? engineChoiceLabel(e) : id; };

  return (
    <>
      <div className="section" data-id="web-agents">
        <h5>{tr('Agent 上网')}</h5>
        <Row label={tr('让 Agent 能搜索和打开网页')} hint={tr('每个对话里的 Claude 多出「搜索」和「浏览器」两类工具。改动对之后新开的对话生效。')}>
          <button className={clsx('toggle', st?.enabled && 'on')} role="switch" aria-checked={!!st?.enabled} aria-label={tr('让 Agent 能搜索和打开网页')} disabled={!st} data-id="web-on" onClick={() => void set('web.mcp', !st?.enabled)} />
        </Row>
        <Row label={tr('Agent 用哪个浏览器操作网页')} hint={
          <>
            {st?.ego.found
              ? tr('找到了 ego lite{v}。选它时，Agent 打开、点击、填表、截图都在 ego lite 里做，用的是你在 ego lite 里的登录，每个对话一个单独的 Space，不动你自己的标签页；它用不了时退回内置浏览器。', { v: st.ego.version ? ` v${st.ego.version}` : '' })
              : tr('没找到 ego lite。装好它并完成首次引导（会装上 ego-browser 命令）后点「重新检测」；在那之前用内置浏览器。')}
            {' '}{tr('改动对之后新开的对话生效。')}
            {' '}<button type="button" className="link" data-id="web-ego-get" onClick={() => openExternal(EGO_URL)}>{tr('ego lite 官网')}</button>
          </>
        }>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select className="field" aria-label={tr('Agent 用哪个浏览器操作网页')} data-id="web-agent-browser" disabled={!st} value={st?.agentBrowser ?? 'auto'} onValueChange={(value) => void set('web.browser.agent', String(value) === 'builtin' ? 'builtin' : undefined)} options={[
              { value: 'auto', label: tr('ego lite（装了就用它）'), description: st && !st.ego.found ? tr('没找到，现在用内置浏览器') : undefined },
              { value: 'builtin', label: tr('内置浏览器') },
            ]} />
            <button className="btn sm ghost" data-id="web-ego-detect" disabled={detecting} onClick={() => void detect()}>{detecting ? tr('检测中…') : tr('重新检测')}</button>
          </div>
        </Row>
        <Row label={tr('用什么搜索')} hint={st && !st.host
          ? tr('现在没有桌面窗口连着（网页版、手机）：只能由这台电脑直接去抓 Bing 和 DuckDuckGo 的结果页，容易被限流；Google、Yahoo、百度要桌面版的内置浏览器。')
          : tr('搜索是在内置浏览器里做的：打开搜索网站的结果页，把结果读出来，不用密钥。自动 = 依次试 DuckDuckGo、Bing、Yahoo、百度，哪个给出对题的结果就用哪个。哪一家能用和你的网络有关，用下面的「试一下」看看。')}>
          <Select className="field" aria-label={tr('用什么搜索')} data-id="web-search" disabled={!st} value={st?.engine ?? 'auto'} onValueChange={(value) => void set('web.search.engine', String(value))} options={(st?.engines ?? []).map((e) => ({ value: e.id, label: engineChoiceLabel(e), description: e.browser && !st?.host ? tr('要桌面版') : undefined }))} />
        </Row>
        {current?.needsKey && (
          <Row label={tr('Brave Search 的密钥')} hint={current.hasKey ? tr('已经保存在这台电脑上（加密）。填一个新的会替换它。') : tr('保存在这台电脑上（加密），只在搜索时发给这家服务。')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="field" type="password" style={{ width: 220 }} autoComplete="off" placeholder={current.hasKey ? tr('••••••（已保存）') : tr('粘贴密钥')} aria-label={tr('Brave Search 的密钥')} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && key.trim()) void saveKey(key.trim()); }} />
              <button className="btn sm" disabled={busy || !key.trim()} onClick={() => void saveKey(key.trim())}>{tr('保存')}</button>
              {current.hasKey && <button className="btn sm ghost" disabled={busy} onClick={() => void saveKey('')}>{tr('删除')}</button>}
            </div>
          </Row>
        )}
        <Row label={tr('试一下')} hint={tr('用上面选的搜一次，看看在你的网络下搜不搜得到。某个搜索网站要求验证时，在右侧面板的浏览器里打开它、验证一次，之后就能搜了。')}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="field" style={{ width: 220 }} placeholder={tr('随便搜点什么')} aria-label={tr('试着搜索')} data-id="web-try" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) void search(); }} />
            <button className="btn sm" disabled={searching || !q.trim()} onClick={() => void search()}>{searching ? tr('搜索中…') : tr('搜索')}</button>
          </div>
        </Row>
        {err && <div className="sub" style={{ color: 'var(--err)', marginTop: 6 }} role="alert">{tr('没有搜到：{err}', { err })}</div>}
        {found && (
          <div className="web-found" data-id="web-found">
            <div className="sub">{found.results.length ? tr('{label} 找到 {resultsCount} 条', { label: label(found.engine), resultsCount: found.results.length }) : tr('{label} 没有找到结果', { label: label(found.engine) })}{found.weak ? tr('（和搜索词只对上了一部分）') : ''}</div>
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
        <h5>{tr('内置浏览器')}</h5>
        <Row label={tr('Agent 在哪里打开网页')} hint={st?.host ? tr('在桌面窗口右侧面板的「浏览器」里，每个对话的 Agent 各用一个标签页，你看得到它在做什么。') : tr('现在没有桌面窗口连着（网页版、手机）：Agent 只能读网页上的文字，点击、填表和截图要桌面版。')}>
          <button className="btn sm" onClick={() => { useStore.setState({ settingsOpen: null }); showPanel('browser'); }}><Icon name="web" size={13} /> {tr('打开浏览器')}</button>
        </Row>
        <Row label={tr('保留 Cookie')} hint={tr('{desc}。已经打开的页面还用原来的，之后新开的页面用新的设置。', { desc: cookieModeText(cookieMode).desc })}>
          <Select className="field" aria-label={tr('保留 Cookie')} data-id="web-cookies" value={cookieMode} onValueChange={(value) => void set(COOKIES_KEY, String(value))} options={COOKIE_MODES.map((m) => ({ value: m, label: cookieModeText(m).label }))} />
        </Row>
        {/* the site card's 「设置 → 联网 → 允许的网站 里可以删掉」 points here (PermissionCards.tsx) */}
        <Row label={tr('允许的网站')} hint={sites.length ? tr('Agent 在内置浏览器里打开这 {n} 个网站、在上面操作页面都不再问你；别的网站第一次打开或操作时问一次。', { n: sites.length }) : tr('在权限卡上点「总是允许这个网站」的网站会列在这里。')}>
          <button className="btn sm" data-id="web-allowed-sites" onClick={() => setSitesOpen(true)}>{tr('管理…')}</button>
        </Row>
        {sitesOpen && <AllowedSites onClose={() => setSitesOpen(false)} />}
      </div>
    </>
  );
}
