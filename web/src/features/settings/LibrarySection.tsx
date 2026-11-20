import { openClaudeAiImport } from '@/features/cloud/cloud-open';
import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import type { AgentKind, LocalHistorySource, SourceStatus } from '@shared';
import { tr } from '@/i18n';

type Tone = 'ok' | 'warn' | 'err' | 'muted';

/** 「刚刚」/「5 分钟前」/ a date — util's ago() has no 前 suffix. */
function since(t: number) { const a = ago(t); return /^\d/.test(a) ? tr('{a}前', { a }) : a; }

/** One status label per source: 未安装 / 检测到未加入 / 已加入 / 不可用：原因. */
function statusOf(x: SourceStatus): { text: string; tone: Tone; dot: string } {
  if (x.joined && !x.enabled) {
    return { text: tr('不可用：{disabledReason}', { disabledReason: x.disabledReason ?? x.error ?? tr('未知原因') }), tone: 'err', dot: 'error' };
  }
  if (x.joined) return { text: tr('已加入'), tone: 'ok', dot: 'idle' };
  if (!x.installed && !x.detected) return { text: tr('未安装'), tone: 'muted', dot: '' };
  return { text: tr('检测到未加入'), tone: 'warn', dot: 'waiting' };
}

function SourceRow({ x, busy, onToggle }: { x: SourceStatus; busy: boolean; onToggle: (x: SourceStatus) => void }) {
  const st = statusOf(x);
  const claude = x.kind === 'claude';
  const canJoin = x.joined || x.installed || x.detected;
  const meta = [
    x.version,
    x.joined && x.loading ? tr('正在读取…') : x.joined && x.count != null ? tr('{count} 个对话', { count: x.count }) : null,
    x.joined ? (x.indexedAt ? tr('上次索引 {since}', { since: since(x.indexedAt) }) : tr('尚未索引')) : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className={clsx('row', !x.joined && !canJoin && 'muted')} style={{ alignItems: 'center', gap: 10 }}>
      <span className={clsx('dot', st.dot)} />
      <Icon name={AGENT_ICONS[x.kind] ?? 'agent'} size={16} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div>
          {x.name}
          <span className={clsx('badge', st.tone !== 'muted' && st.tone)} style={{ marginLeft: 8 }}>{st.tone === 'err' ? tr('不可用') : st.text}</span>
          {claude && <span className="badge" style={{ marginLeft: 4 }}>{tr('始终包含')}</span>}
          {x.caps && !x.caps.resume && <span className="badge" style={{ marginLeft: 4 }}>{tr('只读')}</span>}
        </div>
        {meta && <div className="sub">{meta}</div>}
        {st.tone === 'err' && <div className="sub err">{st.text}</div>}
        {st.tone !== 'err' && x.error && <div className="sub" style={{ color: 'var(--warn)' }}>{tr('上次读取失败，显示的是缓存：{error}', { error: x.error })}</div>}
      </div>
      {(busy || (x.joined && x.loading)) && <span className="spinner" />}
      {!claude && (
        <button
          className={clsx('toggle', x.joined && 'on')}
          role="switch"
          aria-checked={x.joined}
          aria-label={x.joined ? tr('从对话库移出 {name}', { name: x.name }) : tr('把 {name} 加入对话库', { name: x.name })}
          title={x.joined ? tr('移出：只是不在这里显示，不会删除 agent 自己的记录') : canJoin ? tr('加入对话库：列出它的对话并建立索引') : tr('未安装，无法加入')}
          disabled={busy || !canJoin}
          onClick={() => onToggle(x)}
        />
      )}
    </div>
  );
}

/** 设置 → 记忆与对话库: which agents' own session records show up in the sidebar, and the search index. */
export function LibrarySection() {
  const sources = useStore((s) => s.librarySources);
  const load = useStore((s) => s.loadLibrarySources);
  const toast = useStore((s) => s.toast);
  const [busyKind, setBusyKind] = useState<AgentKind | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [loaded, setLoaded] = useState(sources.length > 0);
  const [local, setLocal] = useState<LocalHistorySource[]>([]);
  useEffect(() => { load().catch((e) => toast(e.message)).finally(() => setLoaded(true)); }, []);
  useEffect(() => { ws.request<LocalHistorySource[]>({ kind: 'library.localScan' }).then(setLocal).catch(() => setLocal([])); }, []);

  const toggle = async (x: SourceStatus) => {
    if (x.joined && !(await dlg.confirm(tr('从对话库移出「{name}」？', { name: x.name }), { message: tr('只是不在这里显示，不会删除 agent 自己的记录；以后可以随时重新加入。'), okLabel: tr('移出') }))) return;
    setBusyKind(x.kind);
    try {
      const r = await ws.request<SourceStatus[]>({ kind: 'library.join', kind_: x.kind, joined: !x.joined });
      if (Array.isArray(r)) useStore.setState({ librarySources: r });
    } catch (e: any) { toast(e.message); } finally { setBusyKind(null); }
  };
  const reindex = async () => {
    setIndexing(true);
    try {
      await ws.request({ kind: 'library.reindex' });
      await load();
    } catch (e: any) { toast(e.message); } finally { setIndexing(false); }
  };

  // Claude first, then joined, then detected, then not installed
  const rank = (x: SourceStatus) => (x.kind === 'claude' ? 0 : x.joined ? 1 : x.installed || x.detected ? 2 : 3);
  const rows = [...sources].sort((a, b) => rank(a) - rank(b));
  const last = Math.max(0, ...sources.map((x) => x.indexedAt ?? 0));

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>{tr('来源')}</h5>
        <span className="sub">{tr('加入后，它的历史对话出现在侧栏，可以一起搜索、接着聊')}</span>
      </div>
      <div className="list">
        {rows.map((x) => <SourceRow key={x.kind} x={x} busy={busyKind === x.kind} onToggle={toggle} />)}
        {rows.length === 0 && <div className="empty">{loaded ? tr('没有检测到可加入的 agent') : tr('检测中…')}</div>}
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        {tr('加入后才会启动该 agent 的读取进程并建立索引；移出只是不在这里显示，不会删除 agent 自己的记录。 修改其它 Agent 的对话只走它的官方接口，没有接口的来源只读。')}
      </div>
      {local.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 4 }}>
            <h5 style={{ margin: 0 }}>{tr('本机发现')}</h5>
            <span className="sub">{tr('只检查常见位置，不扫描整个磁盘，也不读取凭据')}</span>
          </div>
          <div className="list">
            {local.map((x) => (
              <div key={x.id} className="row" style={{ alignItems: 'center', gap: 10 }}>
                <span className={clsx('dot', x.readable ? 'idle' : '')} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>
                    {x.name}
                    <span className="badge" style={{ marginLeft: 8 }}>{x.readable ? tr('可读取') : tr('找到数据')}</span>
                  </div>
                  <div className="sub mono" title={x.path}>{x.path}</div>
                  {x.detail && <div className="sub">{x.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button className="btn sm" disabled={indexing} onClick={reindex}>
          {indexing ? <span className="spinner" /> : <Icon name="refresh" size={12} />} {indexing ? tr('正在重建索引…') : tr('重建索引')}
        </button>
        <span className="sub">{last ? tr('上次索引 {since}', { since: since(last) }) : tr('索引在后台自动更新；搜索不到时可以手动重建')}</span>
      </div>
      {/* 导入 claude.ai 数据 (stage F4): the export zip → the claude.ai source here + projects */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <button className="btn sm" data-act="claudeai-import" onClick={() => openClaudeAiImport()}><Icon name="cloud" size={12} /> {tr('导入 claude.ai 数据…')}</button>
        <span className="sub">{tr('claude.ai 的数据导出包：对话进对话库，项目变成这里的项目')}</span>
      </div>
    </div>
  );
}
