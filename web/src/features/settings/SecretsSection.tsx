import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import type { SecretsStatus } from '@shared';
import { tr } from '@/i18n';

const SCHEME_LABEL = { dpapi: tr('Windows DPAPI（当前用户）'), keychain: tr('macOS 钥匙串'), libsecret: tr('Linux 密钥环（libsecret）'), plain: tr('仅编码（此平台没有系统钥匙串）') };

export function SecretsSection() {
  const [st, setSt] = useState<SecretsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const load = () => ws.request<SecretsStatus>({ kind: 'secrets.status' }).then(setSt).catch(() => setSt(null));
  useEffect(() => { void load(); }, []);
  return (
    <div className="section">
      <h5>{tr('API Key 存储')}</h5>
      {st ? (
        <div className="kv">
          <span className="k">{tr('方式')}</span><span>{SCHEME_LABEL[st.scheme]}</span>
          <span className="k">{tr('供应商密钥')}</span><span>{tr('{protected}/{total} 已加密', { protected: st.protected, total: st.total })}{st.total > st.protected && <> · <button className="link" disabled={busy} onClick={async () => { setBusy(true); try { await ws.request({ kind: 'secrets.migrate' }); toast(tr('已加密全部密钥'), true); await load(); } catch (e: any) { toast(e.message); } setBusy(false); }}>{tr('现在加密剩余的')}</button></>}</span>
          <span className="k">{tr('文件')}</span><span className="mono">{tr('~/.claude-web/meta.json（权限 0600）')}</span>
        </div>
      ) : <div className="empty">{tr('读取中…')}</div>}
      <div className="sub" style={{ marginTop: 6 }}>{tr('密钥只在启动对话进程时解密并注入到那个进程的环境变量里，不会出现在 WebSocket 或日志中。Claude 账号登录仍由 Claude Code 自己保存在 ~/.claude/.credentials.json。')}</div>
    </div>
  );
}
