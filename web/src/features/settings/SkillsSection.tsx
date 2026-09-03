import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useScopedSession, useStore } from '@/store';
import { dlg } from '@/ui/dialog';
import type { SkillInfo } from '@shared';

const SUGGESTED = [
  { src: 'anthropics/skills', l: 'Anthropic 官方 skills 合集', d: 'docx / pptx / xlsx / pdf 等文档技能' },
  { src: 'obra/superpowers', l: 'superpowers', d: 'brainstorm / TDD / 调试 / 计划 等工作流技能' },
];

/** Skills: list (user + project), install from GitHub / local, scaffold new, open in editor, remove, backup / restore. */
export function SkillsSection() {
  const active = useScopedSession();
  const openTile = useStore((s) => s.openTile);
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<SkillInfo[]>([]);
  const [src, setSrc] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const cwd = active?.cwd;
  const reload = () => ws.request<SkillInfo[]>({ kind: 'skills.list', cwd }).then(setList).catch((e) => setMsg(e.message));
  useEffect(() => { void reload(); }, [cwd]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg('');
    try { setMsg(await fn()); await reload(); } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  };
  const install = (s = src) => run(async () => { const r = await ws.request<string[]>({ kind: 'skills.install', source: s, scope, cwd }); setSrc(''); return `已安装 ${r.length} 个：${r.map((p) => p.split(/[\\/]/).pop()).join(', ')}`; });
  const create = async () => {
    const name = await dlg.prompt('新 skill 名称', 'my-skill', { message: '小写字母、数字、连字符' });
    if (!name) return;
    const description = (await dlg.prompt('一句话描述（什么时候用）', '')) ?? '';
    await run(async () => { const p = await ws.request<string>({ kind: 'skills.create', name, scope, cwd, description }); openTile({ id: `d${Date.now()}`, kind: 'doc', path: `${p}\\SKILL.md` }, 'tab'); return `已创建 ${p}`; });
  };
  return (
    <>
      <div className="section">
        <h5>已安装（{list.length}）</h5>
        <div className="list">
          {list.map((s) => (
            <div key={s.path} className="row" title={s.path}>
              <span>✦</span>
              <div className="grow">
                <div>/{s.name} <span className="badge">{s.scope === 'user' ? '用户' : '项目'}</span></div>
                <div className="sub">{s.description || s.path}</div>
              </div>
              <button className="btn sm ghost" onClick={() => openTile({ id: `d${Date.now()}`, kind: 'doc', path: `${s.path}\\SKILL.md` }, 'tab')}>编辑</button>
              <button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path: s.path })}>目录</button>
              <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm(`删除 skill「${s.name}」？`, { danger: true })) void run(async () => { await ws.request({ kind: 'skills.remove', path: s.path }); return '已删除'; }); }}>✕</button>
            </div>
          ))}
          {!list.length && <div className="empty">还没有 skill。下面从 GitHub 安装或新建一个。</div>}
        </div>
      </div>
      <div className="section">
        <h5>安装</h5>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="field" style={{ flex: 1 }} placeholder="owner/repo、owner/repo/子目录、GitHub 链接或本地路径" value={src} onChange={(e) => setSrc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && src && install()} />
          <select className="field" value={scope} onChange={(e) => setScope(e.target.value as any)}>
            <option value="user">用户级 ~/.claude/skills</option>
            <option value="project" disabled={!cwd}>项目级 .claude/skills</option>
          </select>
          <button className="btn sm primary" disabled={busy || !src.trim()} onClick={() => install()}>{busy ? '处理中…' : '安装'}</button>
          <button className="btn sm" disabled={busy} onClick={create}>＋ 新建</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {SUGGESTED.map((s) => <button key={s.src} className="chip" title={s.d} disabled={busy} onClick={() => install(s.src)}>{s.l}</button>)}
        </div>
        {msg && <div className="sub" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{msg}</div>}
      </div>
      <div className="section">
        <h5>备份</h5>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" disabled={busy} onClick={() => run(async () => { const f = await ws.request<string>({ kind: 'skills.backup' }); toast('已备份', true); return `已备份到 ${f}`; })}>备份用户级 skills</button>
          <button className="btn sm ghost" onClick={() => ws.request({ kind: 'shell.open', path: '~/.claude-web/backups' }).catch(() => {})}>打开备份目录</button>
        </div>
        <div className="sub" style={{ marginTop: 4 }}>tar 归档放在 ~/.claude-web/backups；恢复：把 tar 解压回 ~/.claude 即可。</div>
      </div>
    </>
  );
}
