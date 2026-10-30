import { useState } from 'react';
import type { ActionClass, BotPolicy, BotStatus, PolicyLevel, PolicyRule, PolicyScope } from '@shared';
import { dlg } from '@/ui/dialog';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { Icon } from '@/ui/icons';
import { clsx } from '@/util';
import { dateLocale, tr } from '@/i18n';
import { classLabel, levelLabel } from './model';
import { updateBot } from './state';
import { confirmRisk, currentBot, doRisk } from './fields';
import { ALL_SCOPE_FIELDS, autoPilotUnlimitedRisk, formOfScope, ScopeEditor, validScope } from './scope-form';

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
 * Send one change of the bot's policy, built from the policy as stored at this moment (after any confirm), so a
 * trust demotion or another edit that landed meanwhile stays. Only the changed key goes (the server merges policy per
 * key): an older 全自动 scope the server would now refuse can't block a level change, and `unleashed` is never in it.
 */
export function patchPolicy(botId: string, change: (cur: BotPolicy) => Pick<BotPolicy, 'rules'>): Promise<boolean> {
  const bot = currentBot(botId);
  if (!bot) return Promise.resolve(false);
  return updateBot(botId, { policy: change(bot.policy) as BotPolicy });
}

const plainOf = (rules: PolicyRule[], cls: ActionClass) => rules.find((r) => r.cls === cls && !r.scope);

/** One class: its level (four), then the scoped rules under it. */
function ClassRow({ bot, cls }: { bot: BotStatus; cls: ActionClass }) {
  const rules = bot.policy.rules;
  const level = plainOf(rules, cls)?.level ?? DEFAULT_LEVEL[cls];
  const scoped = rules.filter((r) => r.cls === cls && r.scope);
  const setLevel = async (l: PolicyLevel) => {
    if (l === level) return;
    // 做了告诉我 runs it unasked too (it only reports afterwards): the same question as 直接做
    const risk = l === 'do' || l === 'do_tell' ? doRisk(cls, l) : null;
    if (risk && !(await confirmRisk(risk))) return;
    void patchPolicy(bot.id, (cur) => ({ rules: [...cur.rules.filter((r) => !(r.cls === cls && !r.scope)), { cls, level: l }] }));
  };
  const remove = async (r: PolicyRule) => {
    if (!(await dlg.confirm(tr('删除这条「{cls}」的规则？', { cls: classLabel(cls) }), { message: `${levelLabel(r.level)} · ${scopeText(r.scope)}`, focusCancel: true, okLabel: tr('删除') }))) return;
    void patchPolicy(bot.id, (cur) => ({ rules: cur.rules.filter((x) => !sameRule(x, r)) }));
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

/** Send 全自动 alone (`policy.autoPilot`; the server merges policy per key, so the rules are left as stored). */
function sendAutoPilot(botId: string, autoPilot: NonNullable<BotPolicy['autoPilot']>): Promise<boolean> {
  return updateBot(botId, { policy: { autoPilot } as BotPolicy });
}

/**
 * 全自动: on / off, and the scope it acts in without asking. Turning it on opens the scope form first; 保存 sends on
 * and the whole scope at once — one that names a destination, or `{unlimited:true}` when every field was ticked
 * 无限制 (each tick confirmed, then once more for the whole). Turning it off never asks.
 */
function AutoPilot({ bot }: { bot: BotStatus }) {
  const ap = bot.policy.autoPilot;
  const on = !!ap?.on;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (scope: PolicyScope) => {
    if (scope.unlimited && !(await confirmRisk(tr('全自动没有任何范围：发送、付款、删除都会直接做，不再问你。确定？')))) return;
    setBusy(true);
    const ok = await sendAutoPilot(bot.id, { on: true, scope });
    setBusy(false);
    if (ok) setEditing(false);
  };
  const toggle = (next: boolean) => {
    if (next) { setEditing(true); return; }
    setEditing(false);
    if (!on) return;
    // the scope stays for next time — unless it is one the server would refuse now (an older, looser rule)
    const cur = currentBot(bot.id)?.policy.autoPilot?.scope;
    void sendAutoPilot(bot.id, { on: false, scope: validScope(cur) ? cur : undefined });
  };
  return (
    <section className="bd-card bd-autopilot">
      <div className="bd-row">
        <span>{tr('全自动')}</span>
        <Switch on={on} label={tr('全自动')} disabled={busy} onChange={toggle} />
        <span className="bd-hint">{tr('范围内的动作都直接做，不问你；到期自动关')}</span>
      </div>
      {editing ? (
        <ScopeEditor
          className="bd-form bd-ap-form"
          head={on ? tr('全自动的范围：') : tr('先定范围，保存后才打开全自动：')}
          fields={ALL_SCOPE_FIELDS}
          initial={formOfScope(ap?.scope)}
          risk={autoPilotUnlimitedRisk}
          okLabel={on ? tr('保存') : tr('保存并打开全自动')}
          busy={busy}
          onSend={(scope) => void save(scope)}
          onCancel={() => setEditing(false)}
        />
      ) : on && (
        <div className="bd-row bd-ap-scope">
          <span>{tr('范围')}</span>
          <span className="bd-scope">{scopeText(ap?.scope)}</span>
          <button className="btn sm" onClick={() => setEditing(true)}>{tr('改范围')}</button>
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
