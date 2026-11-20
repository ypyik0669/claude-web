import { useMemo } from 'react';
import { useSettledSession } from '@/store';
import { convStats } from '@/model/conv-stats';
import { pct } from '@/model/tokens';
import { speedText } from './stats';
import { tr } from '@/i18n';

/**
 * 「1 轮 · 6 步 · 44 tok/s · 缓存命中 83%」 on the line under the box (redesign 2026-11 「输入框下面这一行」 ②): the
 * conversation so far, quiet text beside the permission chip, there once the first turn is done (the speed as soon as
 * a turn has output). Narrow (composer.css): whole items give way, 轮数 first and then 步数 — they are last in the DOM
 * and the line is laid out right to left, so they are the ones that wrap onto the hidden second line — and 「缓存命中」
 * becomes 「缓存」. What is dropped is in the context ring's card.
 */
export function ConvStatsLine({ sessionId }: { sessionId: string }) {
  // the reducer grows conv.items in place and bumps `version`: key on that, not on the (same) array
  const o = useSettledSession(sessionId);
  const st = useMemo(() => (o ? convStats(o.conv.items) : null), [o?.version]);
  if (!st) return null;
  // the order they give way in: the last first
  const parts: { id: string; text: React.ReactNode; title: string }[] = [
    ...(st.cacheHit !== null ? [{ id: 'cache', text: <><span className="lg">{tr('缓存命中')} </span><span className="sm">{tr('缓存')} </span>{pct(st.cacheHit)}</>, title: tr('全部输入里从提示缓存读的比例') }] : []),
    ...(st.tokPerSec !== null ? [{ id: 'speed', text: speedText(st.tokPerSec), title: tr('输出速度：输出的 token ÷ 模型生成用的时间') }] : []),
    { id: 'steps', text: tr('{steps} 步', { steps: st.steps }), title: tr('模型一共走了 {steps} 步（每次调用模型算一步）', { steps: st.steps }) },
    { id: 'turns', text: tr('{turns} 轮', { turns: st.turns }), title: tr('这个对话发出过 {turns} 轮', { turns: st.turns }) },
  ];
  return (
    <span className="conv-stats" data-id="conv-stats">
      {parts.map((p) => <span key={p.id} data-stat={p.id} title={p.title}>{p.text}</span>)}
    </span>
  );
}
