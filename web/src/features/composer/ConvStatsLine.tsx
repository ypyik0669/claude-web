import { useMemo } from 'react';
import { useSettledSession, useStore } from '@/store';
import { convStats } from '@/model/conv-stats';
import { pct } from '@/model/tokens';
import { tr } from '@/i18n';

/**
 * 「3 轮 · 277 步 · 231 tok/s · 缓存命中 99%」 under the composer: the conversation so far in one line, beside the
 * permission chip (the tokens are in the context ring at the end of the row, not repeated). Quiet text, gone when the
 * row is narrow (composer.css) and before the first turn ends; the speed shows as soon as a turn has output.
 */
export function ConvStatsLine({ sessionId }: { sessionId: string }) {
  // the reducer grows conv.items in place and bumps `version`: key on that, not on the (same) array
  const o = useSettledSession(sessionId);
  const st = useMemo(() => (o ? convStats(o.conv.items) : null), [o?.version]);
  if (!st) return null;
  const parts: { text: string; title: string }[] = [
    { text: tr('{turns} 轮', { turns: st.turns }), title: tr('这个对话发出过 {turns} 轮', { turns: st.turns }) },
    { text: tr('{steps} 步', { steps: st.steps }), title: tr('模型一共走了 {steps} 步（每次调用模型算一步）', { steps: st.steps }) },
    ...(st.tokPerSec !== null ? [{ text: `${st.tokPerSec >= 9.95 ? Math.round(st.tokPerSec) : st.tokPerSec.toFixed(1)} tok/s`, title: tr('输出速度：输出的 token ÷ 模型生成用的时间') }] : []),
    ...(st.cacheHit !== null ? [{ text: tr('缓存命中 {pct}', { pct: pct(st.cacheHit) }), title: tr('全部输入里从提示缓存读的比例') }] : []),
  ];
  return (
    <span className="conv-stats" data-id="conv-stats">
      {parts.map((p, i) => <span key={i} title={p.title}>{p.text}</span>)}
    </span>
  );
}
