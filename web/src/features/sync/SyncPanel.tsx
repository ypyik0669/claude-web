import { useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import type { SyncApplyResult, SyncExportResult, SyncPlanItem, SyncPreview } from '@shared';
import { tr } from '@/i18n';

const ACTION: Record<SyncPlanItem['action'], () => string> = {
  add: () => tr('新增'),
  update: () => tr('更新'),
  same: () => tr('相同'),
  conflict: () => tr('冲突：都保留'),
  skip: () => tr('跳过'),
};
const COLLECTION: Record<SyncPlanItem['collection'], () => string> = {
  provider: () => tr('供应商'),
  setting: () => tr('设置'),
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The per-item preview both 导入文件 and 远程同步拉取 use: tick what to apply, then hand the skips back. */
export function SyncPreviewCard({ preview, busy, onApply, onCancel }: {
  preview: SyncPreview;
  busy: boolean;
  onApply: (skip: string[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const changes = preview.items.filter((i) => i.action !== 'same');
  return (
    <div className="gateway-card" style={{ marginTop: 10 }}>
      <div className="gateway-row">
        <b>{tr('预览')}</b>
        <span className="sub">{preview.encrypted ? tr('含加密的密钥') : tr('不含密钥')}</span>
        <span className="grow" />
        <button className="btn sm ghost" disabled={busy} onClick={onCancel}>{tr('取消')}</button>
        <button className="btn sm" disabled={busy || changes.length === 0} onClick={() => void onApply([...skip])}>{tr('导入选中的')}</button>
      </div>
      {changes.length === 0 && <div className="sub">{tr('没有要改的，和这台电脑一样')}</div>}
      {changes.map((it) => (
        <label className="gateway-row" key={it.key}>
          <input
            type="checkbox"
            disabled={it.action === 'skip'}
            checked={it.action !== 'skip' && !skip.has(it.key)}
            onChange={(e) => setSkip((s) => { const n = new Set(s); if (e.target.checked) n.delete(it.key); else n.add(it.key); return n; })}
          />
          <span className="sub">{COLLECTION[it.collection]()}</span>
          <span className="grow">{it.name}</span>
          <span className="sub" style={it.action === 'conflict' ? { color: 'var(--warn)' } : undefined}>{ACTION[it.action]()}</span>
          {it.fields?.length ? <span className="sub">{it.fields.join(', ')}</span> : null}
          {it.note && <span className="sub">{it.note}</span>}
        </label>
      ))}
    </div>
  );
}

/**
 * 备份与同步: export the source settings (keys only inside the passphrase-encrypted part), import = preview what
 * changes item by item, untick what to leave, then apply. Self-contained: the gateway page mounts it.
 */
export function SyncPanel() {
  const toast = useStore((s) => s.toast);
  const [pass, setPass] = useState('');
  const [importPass, setImportPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<string | null>(null);

  const doExport = async () => {
    setBusy(true);
    try {
      const r = await ws.request<SyncExportResult>({ kind: 'sync.export', ...(pass ? { passphrase: pass } : {}) });
      download(r.filename, r.text);
      toast(r.encrypted ? tr('已导出（密钥已加密）') : tr('已导出（不含密钥）'), true);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };

  const doPreview = async (text: string) => {
    setBusy(true);
    try {
      const p = await ws.request<SyncPreview>({ kind: 'sync.import', text, ...(importPass ? { passphrase: importPass } : {}) });
      setPreview(p);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    pending.current = await f.text();
    await doPreview(pending.current);
  };

  const apply = async (skip: string[]) => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await ws.request<SyncApplyResult>({ kind: 'sync.apply', token: preview.token, skip });
      toast(r.conflicts ? tr('已导入 {n} 项，{c} 项冲突两边都保留了', { n: r.applied, c: r.conflicts }) : tr('已导入 {n} 项', { n: r.applied }), true);
      setPreview(null);
      pending.current = null;
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };

  const cancel = () => {
    if (preview) void ws.request({ kind: 'sync.cancel', token: preview.token }).catch(() => {});
    setPreview(null);
    pending.current = null;
  };

  return (
    <div className="gateway-tab cw-sync">
      <div className="gateway-card">
        <div className="gateway-row"><b>{tr('导出')}</b></div>
        <div className="sub">{tr('来源设置、账号、模型映射、路由和隐私规则。不含运行状态和本机路径。')}</div>
        <div className="gateway-row">
          <input type="password" className="input grow" placeholder={tr('口令（留空则不导出密钥）')} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          <button className="btn sm" disabled={busy} onClick={() => void doExport()}>{tr('导出文件')}</button>
        </div>
        <div className="sub">{tr('设了口令，密钥和隐私规则会用它加密；忘了口令就解不开。')}</div>
      </div>

      <div className="gateway-card" style={{ marginTop: 10 }}>
        <div className="gateway-row"><b>{tr('导入')}</b></div>
        <div className="gateway-row">
          <input type="password" className="input grow" placeholder={tr('导出时的口令')} value={importPass} onChange={(e) => setImportPass(e.target.value)} autoComplete="off" />
          <button className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>{tr('选择文件')}</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <div className="sub">{tr('先看会改什么，再决定。两边密钥不同的不会覆盖，两份都留着。')}</div>
      </div>

      {preview && (
        <SyncPreviewCard
          key={preview.token}
          preview={preview}
          busy={busy}
          onApply={apply}
          onCancel={cancel}
        />
      )}
    </div>
  );
}
