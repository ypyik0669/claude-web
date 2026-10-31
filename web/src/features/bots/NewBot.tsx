// 新 Bot 页（spec 2026-10-31 聊天优先 §2）: a face (shape × colour, or 换一个), a name, the folder it works in, 开始 —
// and under it the templates, each one click to start with it. The bot then speaks first in its own conversation (the
// server's kickoff); the rest of the setting up happens there.
import { useEffect, useMemo, useState } from 'react';
import type { BotTemplate, FsDirs } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { pickFolder } from '@/ui/pick-folder';
import { imeComposing } from '@/ui/ime';
import { Icon } from '@/ui/icons';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { BotAvatar } from './BotAvatar';
import { avatarOf, avatarString, COLORS, SHAPES, type AvatarFace } from './avatar-model';
import { startBot, useBots } from './state';

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** A face nobody picked: random shape, colour and seed. */
const randomFace = (): AvatarFace => ({ shape: Math.floor(Math.random() * SHAPES.length), color: Math.floor(Math.random() * COLORS.length), seed: Math.floor(Math.random() * 1000) });

function TemplateCard({ t, busy, onPick }: { t: BotTemplate; busy: boolean; onPick: (t: BotTemplate) => void }) {
  return (
    <button type="button" className="bn-tpl" data-id={t.id} disabled={busy} onClick={() => onPick(t)}>
      <BotAvatar name={t.name} size={28} />
      <span className="bn-tpl-text">
        <span className="bn-tpl-name">{t.name}</span>
        <span className="bn-tpl-desc">{t.desc}</span>
        {t.risk && <span className="bn-tpl-risk">{t.risk}</span>}
      </span>
    </button>
  );
}

export function NewBot() {
  const templates = useBots((s) => s.templates);
  // the focused conversation's folder (a bot's own conversation does not count: it is not in the layout)
  const activeCwd = useStore((s) => (s.activeId ? s.open[s.activeId]?.cwd ?? '' : ''));
  const [home, setHome] = useState('');
  useEffect(() => {
    let live = true;
    ws.request<FsDirs>({ kind: 'fs.dirs' }).then((d) => { if (live && d?.home) setHome(d.home); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const [picked, setPicked] = useState('');
  const cwd = picked || activeCwd || home;
  const [name, setName] = useState('');
  // null: the face follows the name until one is picked
  const [own, setOwn] = useState<AvatarFace | null>(null);
  const face = useMemo(() => own ?? avatarOf(name.trim() || '?'), [own, name]);
  const [busy, setBusy] = useState(false);

  const start = async (t?: BotTemplate) => {
    const n = name.trim() || t?.name || '';
    if (!n || busy) return;
    setBusy(true);
    // a template with no name typed and no face picked: the template's name and its face
    const avatar = avatarString(own ?? avatarOf(n));
    const made = await startBot({ name: n, avatar, templateId: t?.id, cwd });
    setBusy(false);
    if (made) { setName(''); setOwn(null); }
  };
  const pick = async () => { const p = await pickFolder({ start: cwd || undefined }); if (p) setPicked(p); };

  return (
    <div className="bot-new" aria-label={tr('新 Bot')}>
      <div className="bn-card">
        <h3 className="bn-h">{tr('新 Bot')}</h3>
        <div className="bn-face">
          <BotAvatar name={name || '?'} avatar={avatarString(face)} size={72} />
          <div className="bn-pick">
            <div className="bn-shapes" role="radiogroup" aria-label={tr('形状')}>
              {SHAPES.map((d, i) => (
                <button key={i} type="button" role="radio" aria-checked={face.shape === i} aria-label={tr('形状 {n}', { n: i + 1 })} className={clsx('bn-shape', face.shape === i && 'on')} onClick={() => setOwn({ ...face, shape: i })}>
                  <svg viewBox="-2 -2 36 36" width={20} height={20} aria-hidden="true" style={{ color: COLORS[face.color] }}><path d={d} fill="currentColor" /></svg>
                </button>
              ))}
            </div>
            <div className="bn-colors" role="radiogroup" aria-label={tr('颜色')}>
              {COLORS.map((c, i) => (
                <button key={i} type="button" role="radio" aria-checked={face.color === i} aria-label={tr('颜色 {n}', { n: i + 1 })} className={clsx('bn-color', face.color === i && 'on')} style={{ background: c }} onClick={() => setOwn({ ...face, color: i })} />
              ))}
            </div>
            <button type="button" className="btn sm ghost" onClick={() => setOwn(randomFace())}><Icon name="refresh" size={12} />{tr('换一个')}</button>
          </div>
        </div>
        <label className="bn-name">
          <span>{tr('名字')}</span>
          <input
            className="field"
            value={name}
            maxLength={40}
            placeholder={tr('比如：晨报')}
            aria-label={tr('名字')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (imeComposing(e.nativeEvent)) return; if (e.key === 'Enter') { e.preventDefault(); void start(); } }}
          />
        </label>
        <div className="bn-row">
          <button type="button" className="chip bn-cwd" title={cwd || tr('选择工作目录')} onClick={() => void pick()}><Icon name="folder" size={12} /><span className="l">{cwd ? baseName(cwd) : tr('选择工作目录')}</span></button>
          <span className="grow" />
          <button type="button" className="btn primary" data-act="start" disabled={!name.trim() || busy} onClick={() => void start()}>{busy ? tr('正在叫醒…') : tr('开始')}</button>
        </div>
        <div className="bn-note">{tr('开始后它会先跟你打招呼，问你想让它帮什么。')}</div>
      </div>
      {templates.length > 0 && (
        <section className="bn-tpls" aria-label={tr('从模板开始')}>
          <h4 className="bn-tpls-h">{tr('从模板开始')}</h4>
          <div className="bn-tpl-grid">{templates.map((t) => <TemplateCard key={t.id} t={t} busy={busy} onPick={(x) => void start(x)} />)}</div>
        </section>
      )}
    </div>
  );
}
