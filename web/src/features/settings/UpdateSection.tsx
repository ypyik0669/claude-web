import { useEffect, useState } from 'react';
import { desktop } from '@/desktop';
import { useStore } from '@/store';

export interface UpdateState { status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'; version?: string; percent?: number; error?: string; notes?: string }

/** Desktop auto-update via electron-updater (GitHub Releases). Browser mode explains how to update the engine instead. */
export function UpdateSection() {
  const [st, setSt] = useState<UpdateState>({ status: 'idle' });
  const engine = useStore((s) => s.engine);
  useEffect(() => {
    if (!desktop?.onUpdate) return;
    const off = desktop.onUpdate((s: UpdateState) => setSt(s));
    void desktop.updateState?.().then((s) => s && setSt(s));
    return off;
  }, []);
  if (!desktop) {
    return (
      <div className="section">
        <h5>更新</h5>
        <div className="sub">浏览器模式：在 claude-web 目录 <code>git pull && npm install && npm run build</code> 后重启服务。运行内核（claude-code-best）在「账号与登录 › 更多选项」里单独更新。</div>
        <div className="kv" style={{ marginTop: 6 }}><span className="k">运行内核</span><span>v{engine?.version ?? '?'}</span></div>
      </div>
    );
  }
  const d = desktop;
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
          {st.status === 'available' && `发现新版本 ${st.version}`}
          {st.status === 'downloading' && `下载中 ${Math.round(st.percent ?? 0)}%`}
          {st.status === 'downloaded' && `已下载 ${st.version}，重启即可安装`}
          {st.status === 'error' && <span style={{ color: 'var(--red)' }}>{st.error}</span>}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn sm" disabled={st.status === 'checking' || st.status === 'downloading'} onClick={() => d.checkUpdate?.()}>检查更新</button>
        {st.status === 'available' && <button className="btn sm primary" onClick={() => d.downloadUpdate?.()}>下载</button>}
        {st.status === 'downloaded' && <button className="btn sm primary" onClick={() => d.installUpdate?.()}>重启并安装</button>}
      </div>
      {st.notes && <pre className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', marginTop: 8 }}>{st.notes}</pre>}
      <div className="sub" style={{ marginTop: 6 }}>更新来自 GitHub Releases；没有配置发布仓库或离线时会显示错误，不影响使用。</div>
    </div>
  );
}
