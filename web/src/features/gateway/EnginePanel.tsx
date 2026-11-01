import { useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import type { EngineId, EngineStatus, EngineStep, Provider } from '@shared';
import { useGateway } from './state';
import { EngineLoginDialog } from './EngineLoginDialog';
import { tr } from '@/i18n';

/** Each step of a long install / start, in words. */
export const ENGINE_STEP_TEXT: Record<EngineStep, string> = {
  release: tr('正在查最新版本…'),
  download: tr('正在下载…'),
  verify: tr('正在校验下载的文件…'),
  unpack: tr('正在解压…'),
  start: tr('正在启动…'),
  connect: tr('正在连接…'),
};

/** What the engine is now, in one line. */
export function engineStateText(e: EngineStatus): string {
  if (e.running) return e.mode === 'connected' ? tr('已连接这台电脑上正在运行的 {name}', { name: e.name }) : tr('正在运行 · 端口 {port}', { port: e.port ?? '?' });
  if (e.detected && !e.providerId) return tr('这台电脑上已经有一个在运行（端口 {port}）', { port: e.detected.port });
  if (e.installed) return tr('已安装 {version} · 没在运行', { version: e.version ?? '' });
  return tr('还没安装');
}

/** An error from the server as the user should read it (the server's own words are already plain; a bare network failure is not). */
function plain(e: any): string {
  const m = String(e?.message ?? e ?? '');
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(m)) return tr('连不上下载地址，检查网络或代理后再试。');
  if (/EADDRINUSE/i.test(m)) return tr('端口被别的程序占着，关掉它或换个端口再试。');
  if (/EACCES|EPERM/i.test(m)) return tr('没有权限写这个文件夹，可能被杀毒软件拦了。');
  return m || tr('出错了');
}

/** How the installed build was checked, after its version (SEC-09). */
function verifiedText(e: EngineStatus): string {
  if (e.bundled) return ` · ${tr('随应用附带')}`;
  if (e.verified === 'pinned') return ` · ${tr('已按本应用固定的校验值核对')}`;
  if (e.verified === 'release') return ` · ${tr('你确认过它的校验值（和发布里附带的一致）')}`;
  if (e.verified === 'recorded') return ` · ${tr('已核对首次安装时记下的校验值')}`;
  return '';
}

/**
 * This app pins no SHA-256 for the version the server downloaded (SEC-09): show the file's hash and ask. Only a yes
 * sends allowUnverified, always together with that exact hash.
 */
export async function confirmEngineHash(name: string, c: NonNullable<EngineStatus['confirm']>): Promise<boolean> {
  return dlg.confirm(tr('安装 {name} {version}？', { name, version: c.version }), {
    message: c.releaseSha256
      ? tr('本应用没有为这个版本固定校验值。下载的文件和发布里附带的校验值一致，但校验值和文件来自同一处，只能说明下载没坏，不能说明文件可信。核对下面的 SHA-256 后再装。')
      : tr('本应用没有为这个版本固定校验值，发布里也没有附带。核对下面的 SHA-256 后再装。'),
    items: [c.asset, `SHA-256: ${c.sha256}`],
    okLabel: tr('确认并安装'),
    danger: true,
    focusCancel: true,
  });
}

/**
 * One local engine (CLIProxyAPI / Magpie): install / connect / start / stop, with each step of a long action and
 * any failure in words. `onReady` hears the provider it registered once it runs (the wizard's 「已可用」).
 */
export function EnginePanel({ id, onReady }: { id: EngineId; onReady?(p: Provider | null): void }) {
  const e = useGateway((s) => s.engines.find((x) => x.id === id));
  const step = useGateway((s) => s.engineStep[id]);
  const error = useGateway((s) => s.engineError[id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [login, setLogin] = useState(false);

  if (!e) return <div className="sub">{tr('正在读取…')}</div>;

  const run = async (what: string, req: Record<string, unknown>, after?: (st: EngineStatus) => void) => {
    setBusy(what);
    useGateway.setState((s) => ({ engineError: { ...s.engineError, [id]: undefined } }));
    try {
      let st = await ws.request<EngineStatus>({ kind: `engines.${what}`, id, ...req } as any);
      // nothing pinned for that version: the user confirms the downloaded file's hash, then install exactly it
      if (st?.confirm) {
        const c = st.confirm;
        if (!(await confirmEngineHash(e.name, c))) return;
        const ok = { allowUnverified: true, sha256: c.sha256 };
        // an upgrade goes through engines.upgrade again (it restarts a running engine on the new build)
        st = what === 'upgrade'
          ? await ws.request<EngineStatus>({ kind: 'engines.upgrade', id, ...ok } as any)
          : await ws.request<EngineStatus>({ kind: 'engines.install', id, version: c.version, ...ok } as any);
        if (st?.confirm) throw new Error(tr('下载的文件和你确认的不是同一个（SHA-256 变了），没有安装'));
        if (what === 'start') st = await ws.request<EngineStatus>({ kind: 'engines.start', id } as any);
      }
      await useGateway.getState().loadEngines();
      void useStore.getState().loadProviders().catch(() => {});
      after?.(st);
    } catch (err) {
      useGateway.setState((s) => ({ engineError: { ...s.engineError, [id]: plain(err) } }));
    } finally {
      setBusy(null);
      useGateway.setState((s) => { const { [id]: _, ...rest } = s.engineStep; return { engineStep: rest }; });
    }
  };
  const ready = (st: EngineStatus) => {
    if (!onReady || !st?.running) return;
    const p = st.providerId ? useStore.getState().providers.find((x) => x.id === st.providerId) ?? null : null;
    onReady(p);
  };
  const connect = async () => {
    // CLIProxyAPI's client key is the user's own (in its config.yaml); Magpie answers without one
    const key = id === 'cliproxyapi' ? await dlg.prompt(tr('它的客户端 Key（config.yaml 里的 api-keys；没设就留空）'), '') : '';
    if (key === null) return;
    await run('connect', { port: e.detected?.port, ...(key ? { key } : {}) }, ready);
  };
  const uninstall = async () => {
    if (!(await dlg.confirm(tr('卸载 {name}？它会停下来，用它的模型也会从模型菜单里去掉。', { name: e.name }), { danger: true, okLabel: tr('卸载') }))) return;
    await run('uninstall', {});
  };

  const doing = busy ? (step ? ENGINE_STEP_TEXT[step] : busy === 'stop' ? tr('正在停止…') : tr('请稍候…')) : step ? ENGINE_STEP_TEXT[step] : '';

  return (
    <div className="gw-engine" data-engine={id}>
      <div className="gw-kv"><span className="muted">{tr('状态')}</span><span>{engineStateText(e)}</span></div>
      {e.installed && e.version && <div className="gw-kv"><span className="muted">{tr('版本')}</span><span>{e.version}{verifiedText(e)}</span></div>}
      {e.platform && !e.installed && <div className="gw-kv"><span className="muted">{tr('来自')}</span><span>{e.repo}</span></div>}
      {doing && <div className="gw-engine-step" role="status"><Icon name="refresh" size={12} /> {doing}</div>}
      {error && <div className="gw-warn" role="alert"><Icon name="alert" size={13} /><span>{error}</span></div>}
      {e.warnings.map((w) => <div key={w} className="gw-warn"><Icon name="alert" size={13} /><span>{w}</span></div>)}
      <div className="gateway-row">
        {e.detected && !e.providerId && !e.running && (
          <button className="btn sm" disabled={!!busy} onClick={() => void connect()}>{tr('连接正在运行的')}</button>
        )}
        {!e.installed && !e.running && (
          <button className="btn sm" disabled={!!busy} onClick={() => void run('start', {}, ready)}>{tr('下载并启动')}</button>
        )}
        {e.installed && !e.running && (
          <button className="btn sm" disabled={!!busy} onClick={() => void run('start', {}, ready)}>{tr('启动')}</button>
        )}
        {/* a copy we only connected to is the user's own program: we never stop it */}
        {e.running && e.mode !== 'connected' && (
          <button className="btn sm ghost" disabled={!!busy} onClick={() => void run('stop', {})}>{tr('停止')}</button>
        )}
        {e.installed && e.mode !== 'connected' && (
          <button className="btn sm" disabled={!!busy} onClick={() => setLogin(true)}>{tr('登录账号')}</button>
        )}
        <span className="grow" />
        {e.installed && e.mode !== 'connected' && (
          <>
            <button className="btn sm ghost" disabled={!!busy} onClick={() => void run('upgrade', {})}>{tr('更新')}</button>
            {e.previousVersion && <button className="btn sm ghost" disabled={!!busy} onClick={() => void run('rollback', {})}>{tr('回到 {version}', { version: e.previousVersion })}</button>}
            {/* the bundled build is part of the app, not something this page can remove */}
            {!e.bundled && <button className="btn sm ghost danger" disabled={!!busy} onClick={() => void uninstall()}>{tr('卸载')}</button>}
          </>
        )}
      </div>
      {login && <EngineLoginDialog engine={id} onClose={() => setLogin(false)} onDone={() => void useGateway.getState().loadEngines()} />}
    </div>
  );
}
