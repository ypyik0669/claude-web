import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import type { SecretsStatus } from '@shared';

const SCHEME_LABEL = { dpapi: 'Windows DPAPI（当前用户）', keychain: 'macOS 钥匙串', plain: '仅编码（此平台没有系统钥匙串）' };

export function SecretsSection() {
  const [st, setSt] = useState<SecretsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const load = () => ws.request<SecretsStatus>({ kind: 'secrets.status' }).then(setSt).catch(() => setSt(null));
  useEffect(() => { void load(); }, []);
  return (
    <div className="section">
      <h5>API Key 存储</h5>
      {st ? (
        <div className="kv">
          <span className="k">方式</span><span>{SCHEME_LABEL[st.scheme]}</span>
          <span className="k">供应商密钥</span><span>{st.protected}/{st.total} 已加密{st.total > st.protected && <> · <button className="link" disabled={busy} onClick={async () => { setBusy(true); try { await ws.request({ kind: 'secrets.migrate' }); toast('已加密全部密钥', true); await load(); } catch (e: any) { toast(e.message); } setBusy(false); }}>现在加密剩余的</button></>}</span>
          <span className="k">文件</span><span className="mono">~/.claude-web/meta.json（权限 0600）</span>
        </div>
      ) : <div className="empty">读取中…</div>}
      <div className="sub" style={{ marginTop: 6 }}>密钥只在启动对话进程时解密并注入到那个进程的环境变量里，不会出现在 WebSocket 或日志中。Claude 账号登录仍由 Claude Code 自己保存在 ~/.claude/.credentials.json。</div>
    </div>
  );
}
