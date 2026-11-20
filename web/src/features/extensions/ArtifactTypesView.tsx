import { useEffect, useMemo, useState } from 'react';
import type { ArtifactTypeInfo } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { EMPTY, emptyText } from '@/ui/terms';
import { tr } from '@/i18n';

interface Listing { root: string; exists: boolean; types: ArtifactTypeInfo[] }

/** What made a folder a type, in a word (the row's small print). */
function formatWord(f: ArtifactTypeInfo['format']): string {
  return f === 'manifest' ? 'artifact-type.json' : f === 'skill' ? 'SKILL.md' : 'index.html';
}

/**
 * 自定义 › Artifact 类型 (界面改版 2026-11 阶段 2, spec #pages 「自定义」): a placeholder this round — open-artifact is
 * not wired in, so there are no built-in types to list and nothing to switch on. What it shows is real: the folders the
 * user put in ~/.agents/artifact-types (open-artifact's user type root), marked 自己加的; with none, a line on what the
 * tab will hold. The search box is there once there is something to search.
 */
export function ArtifactTypesView() {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Listing | null>(null);
  const [q, setQ] = useState('');
  const load = () => ws.request<Listing>({ kind: 'artifactTypes.list' }).then(setList).catch((e) => { setList((l) => l ?? { root: '', exists: false, types: [] }); toast(e.message); });
  useEffect(() => { void load(); }, []);
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    return (list?.types ?? []).filter((t) => !w || `${t.name} ${t.id} ${t.summary ?? ''}`.toLowerCase().includes(w));
  }, [list, q]);
  const types = list?.types ?? [];

  return (
    <div className="cx" data-id="artifact-types">
      {types.length > 0 && (
        <div className="cx-bar">
          <label className="cx-search">
            <Icon name="search" size={15} />
            <input value={q} placeholder={tr('搜索 Artifact 类型…')} aria-label={tr('搜索 Artifact 类型')} onChange={(e) => setQ(e.target.value)} />
            {q && <button type="button" className="icon-btn xs" aria-label={tr('清除')} onClick={() => setQ('')}><Icon name="close" size={12} /></button>}
          </label>
          <button type="button" className="btn sm" onClick={() => void load()}><Icon name="refresh" size={13} />{tr('重新读取')}</button>
        </div>
      )}

      {types.length > 0 && (
        <section className="cx-sec" data-id="installed">
          <div className="cx-h"><h3>{tr('已装')}</h3><span className="n">{types.length}</span></div>
          <div className="cx-grid one">
            {shown.map((t) => (
              <div key={t.path} className="cx-row on" data-type={t.id} title={t.path}>
                <span className="tile-ic tint-accent"><Icon name="works" size={18} /></span>
                <span className="cx-tx">
                  <span className="cx-n">{t.name}<span className="cx-need" title={tr('放在 ~/.agents/artifact-types 里的文件夹')}>{tr('自己加的')}</span>{t.version && <span className="cx-ver">v{t.version}</span>}</span>
                  <span className="cx-d">{t.summary || tr('（没有写说明）')}</span>
                  <span className="cx-d mono">{`~/.agents/artifact-types/${t.id} · ${formatWord(t.format)}`}</span>
                </span>
                <span className="cx-acts">
                  <button className="icon-btn" title={tr('在文件管理器里打开')} aria-label={tr('打开 {name} 的文件夹', { name: t.name })} onClick={() => void ws.request({ kind: 'shell.open', path: t.path }).catch((e) => toast(e.message))}><Icon name="folder" size={15} /></button>
                </span>
              </div>
            ))}
          </div>
          {!shown.length && <div className="cx-none">{tr('没有叫「{q}」的。', { q })}</div>}
        </section>
      )}

      {list && !types.length && (
        <section className="cx-sec cx-empty" data-id="empty">
          <span className="tile-ic tint-ink"><Icon name="works" size={22} /></span>
          <p className="cx-empty-line">{emptyText(EMPTY.artifactTypes)}</p>
          <p>{tr('到时每种类型一行：一个开关、用在哪些项目，⋯ 里是更新、卸载和看说明。现在就能自己加：把一个类型的文件夹（里面有 artifact-type.json 或 SKILL.md）放进下面这个文件夹，再点「重新读取」。')}</p>
          <code className="cx-path">~/.agents/artifact-types</code>
          <div className="cx-empty-acts">
            {list.exists && <button type="button" className="btn sm" onClick={() => void ws.request({ kind: 'shell.open', path: list.root }).catch((e) => toast(e.message))}><Icon name="folder" size={13} />{tr('打开这个文件夹')}</button>}
            <button type="button" className="btn sm" onClick={() => void load()}><Icon name="refresh" size={13} />{tr('重新读取')}</button>
          </div>
        </section>
      )}
      {!list && <div className="cx-none">{tr('读取中…')}</div>}
    </div>
  );
}
