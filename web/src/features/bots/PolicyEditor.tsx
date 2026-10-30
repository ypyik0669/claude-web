import { useState, type ReactNode } from 'react';
import type { ActionClass, BotPolicy, BotStatus, PolicyLevel, PolicyRule, PolicyScope } from '@shared';
import { dlg } from '@/ui/dialog';
import { Select } from '@/ui/Select';
import { Switch, SwitchChip } from '@/ui/Switch';
import { Icon } from '@/ui/icons';
import { clsx } from '@/util';
import { dateLocale, tr } from '@/i18n';
import { classLabel, levelLabel } from './model';
import { updateBot } from './state';
import { BlurField, NumField, confirmRisk, currentBot, doRisk, policyPatch, splitList } from './fields';

export const CLASSES: ActionClass[] = ['read', 'write_local', 'browser', 'send', 'pay', 'delete', 'install'];
const LEVELS: PolicyLevel[] = ['do', 'do_tell', 'ask', 'deny'];
/** spec §5: wide but safe */
export const DEFAULT_LEVEL: Record<ActionClass, PolicyLevel> = { read: 'do', write_local: 'do', browser: 'do', install: 'do_tell', send: 'ask', pay: 'ask', delete: 'ask' };
/** approvals in a row that make the bot propose an upgrade (server: policy/trust.ts) */
const TRUST_N = 3;

const day = (t: number) => new Date(t).toLocaleDateString(dateLocale());

/** A scope in words: 「频道 C1、C2 · 金额 ≤ 50 · 每天 10 次 · 到 11/30」. */
export function scopeText(s: PolicyScope | undefined): string {
  if (!s || s.unlimited) return tr('无限制');
  const parts = [
    s.recipients?.length ? tr('收件人 {list}', { list: s.recipients.join('、') }) : '',
    s.domains?.length ? tr('域名 {list}', { list: s.domains.join('、') }) : '',
    s.channels?.length ? tr('频道 {list}', { list: s.channels.join('、') }) : '',
    s.maxAmount !== undefined ? tr('金额 ≤ {n}', { n: s.maxAmount }) : '',
    s.perDay !== undefined ? tr('每天 {n} 次', { n: s.perDay }) : '',
    s.until !== undefined ? tr('到 {date}', { date: day(s.until) }) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : tr('无限制');
}

/** The same rule (rules have no id): class, level and scope. */
const sameRule = (a: PolicyRule, b: PolicyRule) => a.cls === b.cls && a.level === b.level && JSON.stringify(a.scope ?? null) === JSON.stringify(b.scope ?? null);

/**
 * Send the bot's policy with one change, built from the policy as stored at this moment (after any confirm), so a
 * trust demotion or another edit that landed meanwhile stays; `unleashed` is never in it (bots.unleash only).
 */
function patchPolicy(botId: string, change: (cur: BotPolicy) => Partial<BotPolicy>): void {
  const bot = currentBot(botId);
  if (!bot) return;
  void updateBot(botId, { policy: policyPatch({ ...bot.policy, ...change(bot.policy) }) });
}

const plainOf = (rules: PolicyRule[], cls: ActionClass) => rules.find((r) => r.cls === cls && !r.scope);

/** One class: its level (four), then the scoped rules under it. */
function ClassRow({ bot, cls }: { bot: BotStatus; cls: ActionClass }) {
  const rules = bot.policy.rules;
  const level = plainOf(rules, cls)?.level ?? DEFAULT_LEVEL[cls];
  const scoped = rules.filter((r) => r.cls === cls && r.scope);
  const setLevel = async (l: PolicyLevel) => {
    if (l === level) return;
    const risk = l === 'do' ? doRisk(cls) : null;
    if (risk && !(await confirmRisk(risk))) return;
    patchPolicy(bot.id, (cur) => ({ rules: [...cur.rules.filter((r) => !(r.cls === cls && !r.scope)), { cls, level: l }] }));
  };
  const remove = async (r: PolicyRule) => {
    if (!(await dlg.confirm(tr('删除这条「{cls}」的规则？', { cls: classLabel(cls) }), { message: `${levelLabel(r.level)} · ${scopeText(r.scope)}`, focusCancel: true, okLabel: tr('删除') }))) return;
    patchPolicy(bot.id, (cur) => ({ rules: cur.rules.filter((x) => !sameRule(x, r)) }));
  };
  return (
    <div className="bd-class" data-cls={cls}>
      <div className="bd-row">
        <span>{classLabel(cls)}</span>
        <Select label={classLabel(cls)} value={level} options={LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))} onValueChange={(v) => void setLevel(v as PolicyLevel)} />
        {level !== DEFAULT_LEVEL[cls] && <span className="bd-hint">{tr('默认：{level}', { level: levelLabel(DEFAULT_LEVEL[cls]) })}</span>}
      </div>
      {scoped.length > 0 && (
        <ul className="bd-scoped">
          {scoped.map((r, i) => (
            <li key={i}>
              <span className={clsx('bd-level', r.level)}>{levelLabel(r.level)}</span>
              <span className="bd-scope">{scopeText(r.scope)}</span>
              <button className="icon-btn" title={tr('删除')} aria-label={tr('删除')} onClick={() => void remove(r)}><Icon name="trash" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Earned trust: per class and target, approvals in a row out of TRUST_N. */
function TrustMap({ bot }: { bot: BotStatus }) {
  const entries = Object.entries(bot.trust);
  if (!entries.length) return <div className="bd-note">{tr('还没有攒下信任。同一类、同一范围的操作你连批 {n} 次，它会提议以后直接做。', { n: TRUST_N })}</div>;
  return (
    <ul className="bd-trust">
      {entries.map(([key, t]) => {
        const at = key.indexOf('|');
        const cls = (at > 0 ? key.slice(0, at) : key) as ActionClass;
        const scope = at > 0 ? key.slice(at + 1) : '';
        const n = Math.min(t.approvals, TRUST_N);
        return (
          <li key={key} title={tr('连续批准 {n} 次', { n: t.approvals })}>
            <span className="bd-trust-name">{CLASSES.includes(cls) ? classLabel(cls) : cls}{scope && scope !== '*' ? ` · ${scope}` : ''}</span>
            <span className="bd-dots" aria-label={`${n}/${TRUST_N}`}>{Array.from({ length: TRUST_N }, (_, i) => <i key={i} className={clsx(i < n && 'on')} />)}</span>
            <span className="bd-hint">{n}/{TRUST_N}</span>
          </li>
        );
      })}
    </ul>
  );
}

type ScopeField = 'domains' | 'channels' | 'recipients' | 'maxAmount' | 'perDay' | 'until';

function fieldLabel(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名');
    case 'channels': return tr('频道');
    case 'recipients': return tr('收件人');
    case 'maxAmount': return tr('金额上限');
    case 'perDay': return tr('每天最多');
    case 'until': return tr('到期');
  }
}

/** What 无限制 on one field lets it do — said once before it is ticked (spec §10). */
function unlimitedRisk(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名不限后，全自动时它可以访问并操作任何网站。确定？');
    case 'channels': return tr('频道不限后，全自动时它可以往任何频道、群发消息。确定？');
    case 'recipients': return tr('收件人不限后，全自动时它可以给任何人发消息、发邮件。确定？');
    case 'maxAmount': return tr('金额不限后，它可以在你不在时无上限花钱。确定？');
    case 'perDay': return tr('次数不限后，它一天里可以不停地做下去，没有次数上限。确定？');
    case 'until': return tr('不设到期后，全自动会一直开着，直到你自己关掉。确定？');
  }
}

const isoDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** 全自动: on / off, and the scope it acts in without asking — every field can be 无限制 (= not set). */
function AutoPilot({ bot }: { bot: BotStatus }) {
  const ap = bot.policy.autoPilot;
  const on = !!ap?.on;
  const scope: PolicyScope = ap?.scope ?? {};
  // fields the user un-ticked 无限制 on but hasn't filled yet
  const [limiting, setLimiting] = useState<Set<ScopeField>>(() => new Set());
  // one scope field over autopilot as stored now
  const setScope = (patch: Partial<PolicyScope>) => patchPolicy(bot.id, (cur) => {
    const next: PolicyScope = { ...cur.autoPilot?.scope, ...patch };
    for (const k of Object.keys(next) as (keyof PolicyScope)[]) if (next[k] === undefined) delete next[k];
    return { autoPilot: { on: !!cur.autoPilot?.on, scope: next } };
  });
  const emptyScope = (s: PolicyScope) => s.unlimited || (!s.domains?.length && !s.channels?.length && !s.recipients?.length && s.maxAmount === undefined && s.perDay === undefined && s.until === undefined);
  const toggle = async (next: boolean) => {
    if (next && emptyScope(scope) && !(await confirmRisk(tr('全自动没有任何范围：发送、付款、删除都会直接做，不再问你。确定？')))) return;
    patchPolicy(bot.id, (cur) => ({ autoPilot: { on: next, scope: cur.autoPilot?.scope } }));
  };
  const setUnlimited = async (f: ScopeField, unlimited: boolean) => {
    if (!unlimited) { setLimiting((s) => new Set(s).add(f)); return; }
    if (!(await confirmRisk(unlimitedRisk(f)))) return;
    setLimiting((s) => { const n = new Set(s); n.delete(f); return n; });
    setScope({ [f]: undefined });
  };
  const fields: ScopeField[] = ['domains', 'channels', 'recipients', 'maxAmount', 'perDay', 'until'];
  return (
    <section className="bd-card bd-autopilot">
      <div className="bd-row">
        <span>{tr('全自动')}</span>
        <Switch on={on} label={tr('全自动')} onChange={(v) => void toggle(v)} />
        <span className="bd-hint">{tr('范围内的动作都直接做，不问你；到期自动关')}</span>
      </div>
      {on && (
        <div className="bd-form">
          {fields.map((f) => {
            const v = scope[f];
            const unlimited = v === undefined && !limiting.has(f);
            let input: ReactNode = null;
            if (!unlimited) {
              if (f === 'maxAmount' || f === 'perDay') input = <NumField label={fieldLabel(f)} value={scope[f]} onSave={(n) => setScope({ [f]: n })} />;
              else if (f === 'until') input = <BlurField type="date" label={fieldLabel(f)} value={scope.until !== undefined ? isoDay(scope.until) : ''} onSave={(s) => { const t = s ? new Date(`${s}T23:59:59`).getTime() : NaN; setScope({ until: Number.isFinite(t) ? t : undefined }); }} />;
              else input = <BlurField label={fieldLabel(f)} placeholder={tr('用逗号隔开')} value={(scope[f] ?? []).join(', ')} onSave={(s) => { const list = splitList(s); setScope({ [f]: list.length ? list : undefined }); }} />;
            }
            return (
              <div className="bd-row" key={f} data-field={f}>
                <span>{fieldLabel(f)}</span>
                <span className="bd-pair">
                  {input}
                  <SwitchChip on={unlimited} onChange={(u) => void setUnlimited(f, u)}>{tr('无限制')}</SwitchChip>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 策略: the level of each of the seven classes (with their scoped rules), the trust earned, and 全自动. */
export function PolicyEditor({ bot }: { bot: BotStatus }) {
  return (
    <div className="bd-policy">
      {bot.policy.unleashed && <div className="bd-warn">{tr('已放开全部：下面的档位暂时不起作用，只有停止和审计还在。')}</div>}
      <section className="bd-card">
        {CLASSES.map((c) => <ClassRow key={c} bot={bot} cls={c} />)}
      </section>
      <h4 className="bd-h">{tr('信任')}</h4>
      <TrustMap bot={bot} />
      <h4 className="bd-h">{tr('全自动')}</h4>
      <AutoPilot bot={bot} />
    </div>
  );
}
