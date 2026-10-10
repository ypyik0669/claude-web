import { useEffect, useMemo, useState } from 'react';
import type { SkillInfo } from '@shared';
import { ws } from '@/ws/client';
import { useScopedSession, useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { joinPath } from '@/features/paths';

/** Collections worth starting from (a GitHub `owner/repo`; the installer takes every folder with a SKILL.md). */
const SUGGESTED = [
  { src: 'anthropics/skills', name: 'Anthropic 官方合集', desc: 'Word、PPT、Excel、PDF 这些文档怎么读、怎么写' },
  { src: 'obra/superpowers', name: 'superpowers', desc: '先想清楚再动手、测试先行、排查问题、写计划这一套做事方法' },
];

type Scope = 'user' | 'project';

/**
 * Skills on the 扩展 page (spec 2026-10-10-ui-structure §4): the ones installed (open, show in folder, delete), a
 * couple of collections to start from, and installing from GitHub or a folder. The same requests as the settings
 * page's list (skills.list / install / create / remove).
 */
export function SkillsView() {
  const active = useScopedSession();
  const openTile = useStore((s) => s.openTile);
  const toast = useStore((s) => s.toast);
  const cwd = active?.cwd;
  const [list, setList] = useState<SkillInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [src, setSrc] = useState('');
  const [scope, setScope] = useState<Scope>('user');
  const [busy, setBusy] = useState<string | null>(null);
  const reload = () => ws.request<SkillInfo[]>({ kind: 'skills.list', cwd }).then(setList).catch((e) => { setList((l) => l ?? []); toast(e.message); });
  useEffect(() => { void reload(); }, [cwd]);
  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try { const said = await fn(); if (said) toast(said, true); await reload(); } catch (e: any) { toast(e.message); }
    setBusy(null);
  };
  const install = (source: string) => run(`install:${source}`, async () => {
    const r = await ws.request<string[]>({ kind: 'skills.install', source, scope, cwd });
    setSrc('');
    return `装好了 ${r.length} 个：${r.map((p) => p.split(/[\\/]/).pop()).join('、')}`;
  });
  const edit = (s: SkillInfo) => openTile({ id: `d${Date.now()}`, kind: 'doc', path: joinPath(s.path, 'SKILL.md') }, 'tab');
  const create = async () => {
    const name = await dlg.prompt('新 Skill 的名字', 'my-skill', { message: '小写字母、数字、连字符' });
    if (!name) return;
    const description = (await dlg.prompt('一句话：什么时候该用它', '')) ?? '';
    await run('create', async () => {
      const p = await ws.request<string>({ kind: 'skills.create', name, scope, cwd, description });
      openTile({ id: `d${Date.now()}`, kind: 'doc', path: joinPath(p, 'SKILL.md') }, 'tab');
    });
  };
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    return (list ?? []).filter((s) => !w || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(w));
  }, [list, q]);

  return (
    <div className="cx">
      <div className="cx-bar">
        <label className="cx-search">
          <Icon name="search" size={15} />
          <input value={q} placeholder="搜索已安装的 Skills…" aria-label="搜索 Skills" onChange={(e) => setQ(e.target.value)} />
          {q && <button type="button" className="icon-btn xs" aria-label="清除" onClick={() => setQ('')}><Icon name="close" size={12} /></button>}
        </label>
        <button className="btn sm cx-new" disabled={busy === 'create'} onClick={create}><Icon name="plus" size={13} />新建 Skill</button>
      </div>

      <section className="cx-sec" data-id="installed">
        <div className="cx-h"><h3>已安装</h3>{list && <span className="n">{list.length}</span>}</div>
        <div className="cx-grid">
          {shown.map((s) => (
            <div key={s.path} className="cx-row on" title={s.path}>
              <span className={clsx('tile-ic', s.scope === 'user' ? 'tint-accent' : 'tint-info')}><Icon name="skill" size={18} /></span>
              <span className="cx-tx">
                <span className="cx-n">{s.name}<span className="cx-need" title={s.scope === 'user' ? '装在你的账户下：所有项目都能用' : '装在这个项目里：只有这个项目能用'}>{s.scope === 'user' ? '所有项目' : '这个项目'}</span></span>
                <span className="cx-d">{s.description || '（没有写说明）'}</span>
              </span>
              <span className="cx-acts">
                <button className="icon-btn" title="打开它的 SKILL.md" aria-label={`编辑 ${s.name}`} onClick={() => edit(s)}><Icon name="edit" size={15} /></button>
                <button className="icon-btn" title="在文件管理器里打开" aria-label={`打开 ${s.name} 的文件夹`} onClick={() => void ws.request({ kind: 'shell.open', path: s.path }).catch((e) => toast(e.message))}><Icon name="folder" size={15} /></button>
                <button className="icon-btn cx-del" title="删除" aria-label={`删除 ${s.name}`} disabled={busy === `rm:${s.path}`} onClick={async () => { if (await dlg.confirm(`删除 Skill「${s.name}」？`, { danger: true })) void run(`rm:${s.path}`, async () => { await ws.request({ kind: 'skills.remove', path: s.path }); }); }}><Icon name="trash" size={15} /></button>
              </span>
            </div>
          ))}
        </div>
        {list && !list.length && <div className="cx-none">还没有 Skill。从下面装一套，或者新建一个。</div>}
        {list && list.length > 0 && !shown.length && <div className="cx-none">没有叫「{q}」的。</div>}
      </section>

      <section className="cx-sec" data-id="suggested">
        <div className="cx-h"><h3>从这里开始</h3></div>
        <div className="cx-grid">
          {SUGGESTED.map((s) => (
            <div key={s.src} className="cx-row" title={`github.com/${s.src}`}>
              <span className="tile-ic tint-ink"><Icon name="library" size={18} /></span>
              <span className="cx-tx"><span className="cx-n">{s.name}</span><span className="cx-d">{s.desc}</span></span>
              <button className="icon-btn cx-add" disabled={!!busy} title={`安装 ${s.name}`} aria-label={`安装 ${s.name}`} onClick={() => void install(s.src)}>{busy === `install:${s.src}` ? <span className="spinner" /> : <Icon name="plus" size={17} />}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="cx-sec" data-id="install">
        <div className="cx-h"><h3>从 GitHub 或文件夹安装</h3></div>
        <div className="cx-form">
          <input className="field" value={src} placeholder="owner/repo、GitHub 链接，或本机的文件夹路径" aria-label="来源" onChange={(e) => setSrc(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && src.trim()) void install(src.trim()); }} />
          <select className="field" value={scope} aria-label="装给谁用" title="装给谁用" onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="user">所有项目</option>
            <option value="project" disabled={!cwd}>只这个项目</option>
          </select>
          <button className="btn primary" disabled={!!busy || !src.trim()} onClick={() => void install(src.trim())}>{busy?.startsWith('install:') ? '安装中…' : '安装'}</button>
        </div>
      </section>
    </div>
  );
}
