import { useEffect, useState } from 'react';
import { desktop } from '@/desktop';
import { useStore } from '@/store';
import type { UpdateState } from '@/features/update/model';
import { clsx } from '@/util';
import { Row } from './controls';

export type { UpdateState };

/**
 * Desktop app updates (desktop/src/main.ts + update-policy.ts; the prompt is features/update/UpdatePrompt.tsx). The
 * app looks by itself shortly after start and every few hours; this page shows where that stands and turns it off.
 * Browser mode explains how to update the checkout instead.
 */
export function UpdateSection() {
  const [st, setSt] = useState<UpdateState>({ status: 'idle' });
  const [auto, setAuto] = useState(true);
  const engine = useStore((s) => s.engine);
  useEffect(() => {
    if (!desktop?.onUpdate) return;
    const off = desktop.onUpdate((s: UpdateState) => setSt(s));
    void desktop.updateState?.().then((s) => s && setSt(s));
    void desktop.getFlags?.().then((f) => setAuto(f?.autoUpdate !== false));
    return off;
  }, []);
  if (!desktop) {
    return (
      <div className="section">
        <h5>更新</h5>
        <div className="sub">浏览器模式：在 claude-web 目录 <code>git pull && npm install && npm run build</code> 后重启服务。运行内核（claude-web-engine）随应用一起更新。</div>
        <div className="kv" style={{ marginTop: 6 }}><span className="k">运行内核</span><span>v{engine?.version ?? '?'}</span></div>
      </div>
    );
  }
  const d = desktop;
  const manual = st.mode === 'manual';
  const toggleAuto = () => { const next = !auto; setAuto(next); void d.setFlags?.({ autoUpdate: next }); };
  return (
    <div className="section">
      <h5>应用更新</h5>
      <div className="kv">
        <span className="k">当前版本</span><span>{d.version}</span>
        <span className="k">状态</span>
        <span>
          {st.status === 'idle' && '尚未检查'}
          {st.status === 'checking' && '检查中…'}
          {st.status === 'none' && '已是最新'}
          {st.status === 'available' && (manual ? `发现新版本 ${st.version}` : `发现新版本 ${st.version}，正在后台下载`)}
          {st.status === 'downloading' && `下载中 ${Math.round(st.percent ?? 0)}%`}
          {st.status === 'downloaded' && `已下载 ${st.version}，重启即可安装（退出软件时也会自动安装）`}
          {st.status === 'error' && <span style={{ color: 'var(--red)' }}>{st.error}</span>}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={st.status === 'checking' || st.status === 'downloading'} onClick={() => d.checkUpdate?.()}>检查更新</button>
        {st.status === 'downloaded' && <button className="btn sm primary" onClick={() => d.installUpdate?.()}>重启并安装</button>}
        {st.url && (manual ? st.status === 'available' : st.status === 'error') && <button className="btn sm primary" onClick={() => void d.openExternal(st.url!)}>下载新版本</button>}
        {st.page && st.version && <button className="btn sm ghost" onClick={() => void d.openExternal(st.page!)}>更新内容</button>}
      </div>
      <Row label="自动检查更新" hint="启动后和每 4 小时一次；有新版本时弹窗提醒。">
        <button className={clsx('toggle', auto && 'on')} role="switch" aria-checked={auto} aria-label="自动检查更新" onClick={toggleAuto} />
      </Row>
      {st.notes && <pre className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 8 }}>{st.notes}</pre>}
      <div className="sub" style={{ marginTop: 6 }}>
        {manual
          ? d.platform === 'darwin'
            ? 'macOS 版没有 Apple 签名，不能自己安装更新：有新版本时会弹窗给出下载链接，下载后把新版拖进「应用程序」替换即可。'
            : '免安装版不能自己更新：有新版本时会弹窗给出下载链接，用新的 exe 替换即可。'
          : '新版本会在后台下载好，然后弹窗问你要不要重启；选「稍后」就在下次退出软件时自动安装。'}
        {' '}更新来自 GitHub Releases，离线或连不上 GitHub 时只会在这里显示错误，不影响使用。
      </div>
    </div>
  );
}
