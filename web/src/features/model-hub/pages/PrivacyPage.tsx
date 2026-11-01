import { useEffect, useState } from 'react';
import type { PrivacyAction, PrivacyCategory, PrivacyPreview, PrivacySettings, PrivacyStatus } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { Select } from '@/ui/Select';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { Icon } from '@/ui/icons';
import { dateLocale, tr } from '@/i18n';
import { actionName, CATEGORIES, categoryName } from '@/features/privacy/PrivacyCenter';

const ACTIONS: PrivacyAction[] = ['off', 'redact', 'warn', 'block'];
const MB = 1024 * 1024;

/** What each type covers (one line under its name). */
function categoryDesc(c: PrivacyCategory): string {
  switch (c) {
    case 'api_key': return tr('sk-…、ghp_…、AKIA… 这类厂商密钥');
    case 'private_key': return tr('PEM 私钥块');
    case 'jwt': return tr('eyJ… 开头的令牌');
    case 'password': return tr('password= / token: 后面的值');
    case 'email': return tr('邮箱地址');
    case 'phone': return tr('中国大陆手机号');
    case 'id_card': return tr('18 位身份证号（校验位对得上）');
    case 'bank_card': return tr('银行卡号（Luhn 校验对得上）');
    case 'name': return tr('中文人名（按上下文判断）；打开本地模型后也找英文人名');
    case 'address': return tr('地址：只有本地模型能找');
    case 'custom': return tr('下面的脱敏词和自定义规则');
  }
}

function Toggle({ title, desc, on, onChange, disabled }: { title: string; desc: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="hub-setrow">
      <div className="tx">
        <b>{title}</b>
        <span>{desc}</span>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title} disabled={disabled} className={`hub-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
    </div>
  );
}

/** A comma / newline separated list, saved on blur or Enter. */
function ListInput({ value, onSave, placeholder, ariaLabel, split }: { value: string[]; onSave: (v: string[]) => void; placeholder: string; ariaLabel: string; split: RegExp }) {
  const joined = value.join(split.source.includes(',') ? ', ' : '\n');
  const [text, setText] = useState(joined);
  useEffect(() => { setText(joined); }, [joined]);
  const save = () => {
    const list = text.split(split).map((x) => x.trim()).filter(Boolean);
    if (list.join('\n') !== value.join('\n')) onSave(list);
  };
  return (
    <input
      className="field"
      style={{ width: '100%' }}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) save(); }}
    />
  );
}

/** The OTLP export switches (`hub.privacy.otlp*` in meta.json, read by the telemetry side). */
function OtlpCard() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const otlp = settings['hub.privacy.otlp'] === true;
  const saved = typeof settings['hub.privacy.otlpUrl'] === 'string' ? (settings['hub.privacy.otlpUrl'] as string) : '';
  const [url, setUrl] = useState(saved);
  useEffect(() => { setUrl(saved); }, [saved]);
  const put = (key: string, value: unknown) => { void setSetting(`hub.privacy.${key}`, value).catch((e: any) => toast(e.message)); };
  return (
    <section className="hub-card" style={{ marginTop: 12 }}>
      <div className="hd">
        <h3>{tr('OTLP 导出')}</h3>
        <span className="hub-grow" />
        <span className={`hub-chip ${otlp ? 'green' : ''}`}>{otlp ? tr('开启') : tr('关闭')}</span>
      </div>
      <div className="bd">
        <Toggle title={tr('导出请求 span')} desc={tr('把每次请求的指标发到你指定的收集器；正文、对话默认不发。')} on={otlp} onChange={(v) => put('otlp', v)} />
        <div className="hub-row" style={{ marginTop: 8 }}>
          <input
            className="field"
            style={{ flex: 1, minWidth: 220 }}
            value={url}
            placeholder="https://collector.example.com/v1/traces"
            aria-label={tr('OTLP 地址')}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => put('otlpUrl', url.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) put('otlpUrl', url.trim()); }}
          />
          <span className="hub-muted hub-sml">{tr('指标 / 正文 / 对话分别控制')}</span>
        </div>
      </div>
    </section>
  );
}

/**
 * 隐私 (spec §6.9): the real privacy pipeline's settings (privacy.get / privacy.set — the same as the privacy center),
 * the optional local model, which agents it reaches, a server-side try-it and the kept records. A change applies to
 * the next request, conversations already running included (立即生效).
 */
export function PrivacyPage() {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<PrivacyStatus | null>(null);
  const [error, setError] = useState('');
  const [sample, setSample] = useState(tr('部署服务时带上 OPENAI_API_KEY=sk-proj-8fK2mQx7Lp4Rt9Vw3Yz6Ab1Cd，出问题联系客户陈建国，li.wei@acme-corp.cn 或 13800138000。'));
  const [preview, setPreview] = useState<PrivacyPreview | null>(null);

  useEffect(() => {
    let alive = true;
    ws.request<PrivacyStatus>({ kind: 'privacy.get' }).then((s) => { if (alive) { setSt(s); setError(''); } }, (e) => { if (alive) setError((e as Error).message); });
    const off = ws.on((ev) => { if (ev.kind === 'privacy.changed') setSt(ev.status); });
    return () => { alive = false; off(); };
  }, []);

  if (!st) return <div className="hub-body"><div className="hub-muted">{error || tr('加载中…')}</div></div>;
  const s = st.settings;
  const model = st.model;

  const save = async (patch: Partial<Omit<PrivacySettings, 'actions'>> & { actions?: Partial<Record<PrivacyCategory, PrivacyAction>> }) => {
    try { setSt(await ws.request<PrivacyStatus>({ kind: 'privacy.set', patch })); } catch (e) { toast((e as Error).message); }
  };
  const ask = async (kind: 'privacy.model.download' | 'privacy.model.cancel' | 'privacy.model.remove' | 'privacy.records.clear') => {
    try { setSt(await ws.request<PrivacyStatus>({ kind })); } catch (e) { toast((e as Error).message); }
  };
  const setEnabled = async (on: boolean) => {
    if (!on) {
      const ok = await dlg.confirm(tr('关闭脱敏？'), {
        message: tr('关闭后，下一次请求会把 API Key、邮箱、密码等内容原样发给厂商。'),
        okLabel: tr('仍然关闭'),
        danger: true,
        focusCancel: true,
      });
      if (!ok) return;
    }
    await save({ enabled: on });
  };
  const removeModel = async () => {
    const ok = await dlg.confirm(tr('删除本地模型？'), {
      message: model?.runtimeOwn ? tr('模型和运行库会从本机删掉，本地模型随之关闭；以后可以再下载。') : tr('模型文件会从本机删掉，本地模型随之关闭；以后可以再下载。'),
      okLabel: tr('删除'),
      danger: true,
    });
    if (ok) await ask('privacy.model.remove');
  };
  const test = async () => {
    try { setPreview(await ws.request<PrivacyPreview>({ kind: 'privacy.preview', text: sample })); } catch (e) { toast((e as Error).message); }
  };

  const recent = st.stats.recent.slice(0, 50);
  const dl = model?.downloading;

  return (
    <div className="hub-body" data-privacy-page>
      <div className="hub-row" style={{ marginBottom: 12 }}>
        <span className={`hub-pill ${s.enabled ? '' : 'off'}`}><span className="dot" />{s.enabled ? tr('脱敏已开启') : tr('脱敏已关闭')}</span>
        <span className="hub-muted hub-sml">
          {st.routed ? tr('改动从下一个请求生效，在跑的对话也一样') : tr('打开后，新开的对话都经过本机中转；之后的改动立即生效')}
        </span>
        <span className="hub-grow" />
        <button type="button" role="switch" aria-checked={s.enabled} aria-label={tr('隐私保护')} className={`hub-switch ${s.enabled ? 'on' : ''}`} onClick={() => void setEnabled(!s.enabled)} />
      </div>

      <div className="hub-privacy">
        <section className="hub-card">
          <div className="hd"><h3>{tr('要遮什么')}</h3></div>
          <div className="bd">
            {CATEGORIES.map((c) => (
              <div className="hub-setrow" key={c} data-privacy-category={c}>
                <div className="tx">
                  <b>{categoryName(c)}</b>
                  <span>{categoryDesc(c)}</span>
                </div>
                <Select
                  className="field"
                  value={s.actions[c]}
                  aria-label={categoryName(c)}
                  onValueChange={(v) => void save({ actions: { [c]: v as PrivacyAction } })}
                  options={ACTIONS.map((a) => ({ value: a, label: actionName(a) }))}
                />
              </div>
            ))}
            <div className="hub-setrow">
              <div className="tx">
                <b>{tr('脱敏词')}</b>
                <span>{tr('人名、项目代号、内部域名……用逗号分隔')}</span>
              </div>
              <div style={{ flex: '1 1 220px', minWidth: 180 }}>
                <ListInput value={s.words} split={/[,，\n]+/} onSave={(v) => void save({ words: v })} placeholder={tr('例如 Nightjar, db.acme-corp.cn')} ariaLabel={tr('脱敏词')} />
              </div>
            </div>
            <div className="hub-setrow">
              <div className="tx">
                <b>{tr('自定义规则')}</b>
                <span>{tr('JavaScript 正则，每行一个')}</span>
              </div>
              <div style={{ flex: '1 1 220px', minWidth: 180 }}>
                <ListInput value={s.patterns} split={/\n+/} onSave={(v) => void save({ patterns: v })} placeholder={tr('例如 TERM-\\d+ 或 /token_[a-z]+/i')} ariaLabel={tr('自定义规则')} />
              </div>
            </div>
            {st.badPatterns.length > 0 && (
              <div className="hub-row hub-sml" style={{ color: 'var(--err)' }}><Icon name="alert" size={13} />{tr('这些规则写错了，没有生效：{list}', { list: st.badPatterns.join('  ') })}</div>
            )}
            <div className="hub-setrow">
              <div className="tx">
                <b>{tr('从不脱敏')}</b>
                <span>{tr('团队邮箱、测试用的 key；这些值总是原样发送')}</span>
              </div>
              <div style={{ flex: '1 1 220px', minWidth: 180 }}>
                <ListInput value={s.allow} split={/[,，\n]+/} onSave={(v) => void save({ allow: v })} placeholder={tr('例如 team@example.com, sk-test-…')} ariaLabel={tr('从不脱敏')} />
              </div>
            </div>
            <Toggle title={tr('本机模型不脱敏')} desc={tr('发给本机（localhost / 局域网）的模型时原样发送')} on={s.skipLocal} onChange={(v) => void save({ skipLocal: v })} />
            <Toggle title={tr('改动立即生效')} desc={tr('打开过一次后，对话都经过本机中转（关着时原样转发），开关和规则对在跑的对话也立即生效')} on={s.standby} onChange={(v) => void save({ standby: v })} />
            <Toggle title={tr('日志和导出也遮住')} desc={tr('本机日志、诊断包里也按上面的类型遮住（密钥总会遮住）')} on={s.output} onChange={(v) => void save({ output: v })} />
            {!s.enabled && (
              <div className="hub-row hub-sml" style={{ color: 'var(--err)', marginTop: 8 }}>
                <Icon name="alert" size={13} />
                {tr('脱敏已关闭：厂商会看到明文。')}
              </div>
            )}
          </div>
        </section>

        <div className="hub-stack">
          <section className="hub-card" data-privacy-model>
            <div className="hd">
              <h3>{tr('本地模型')}</h3>
              <span className="hub-grow" />
              <span className={`hub-chip ${model?.installed && model.runtime && s.model.enabled ? 'green' : ''}`}>
                {dl ? tr('下载中') : !model?.installed ? tr('未下载') : !model.runtime ? tr('运行库未安装') : s.model.enabled ? tr('开启') : tr('关闭')}
              </span>
            </div>
            <div className="bd">
              <div className="hub-muted hub-sml" style={{ marginBottom: 8 }}>
                {tr('{name}：在本机找出规则找不到的人名、地址、密码，不联网。约 {mb} MB，默认关闭。', { name: model?.name ?? 'AstrLink Guard', mb: Math.round((model?.size ?? 0) / MB) })}
              </div>
              {model && !model.runtime && model.runtimeSize === undefined && (
                <div className="hub-row hub-sml" style={{ color: 'var(--warn)', marginBottom: 8 }}>
                  <Icon name="alert" size={13} />
                  {tr('这台电脑的系统没有可下载的运行库，本地模型用不了。')}
                </div>
              )}
              {model && !dl && (!model.installed || (!model.runtime && model.runtimeSize !== undefined)) && (() => {
                const needRuntime = !model.runtime && model.runtimeSize !== undefined;
                const bytes = (model.installed ? 0 : model.size) + (needRuntime ? model.runtimeSize ?? 0 : 0);
                return (
                  <div className="hub-row hub-sml" data-privacy-model-download>
                    <button className="btn sm primary" onClick={() => void ask('privacy.model.download')}>
                      {needRuntime && !model.installed ? tr('下载运行库和模型') : needRuntime ? tr('下载运行库') : tr('下载模型')}
                    </button>
                    <span className="hub-muted">{tr('共约 {mb} MB，下载完就能用，不用重启', { mb: Math.round(bytes / MB) })}</span>
                  </div>
                );
              })()}
              {dl && (
                <div data-privacy-model-progress>
                  <div className="hub-bar" role="progressbar" aria-valuemin={0} aria-valuemax={dl.total} aria-valuenow={dl.done} aria-label={tr('下载进度')}>
                    <i style={{ width: `${dl.total ? Math.min(100, (dl.done / dl.total) * 100) : 0}%` }} />
                  </div>
                  <div className="hub-row hub-sml" style={{ marginTop: 6 }}>
                    <span>{tr('下载中 {done} / {total} MB', { done: (dl.done / MB).toFixed(1), total: (dl.total / MB).toFixed(1) })}</span>
                    <span className="hub-grow" />
                    <button className="btn sm ghost" onClick={() => void ask('privacy.model.cancel')}>{tr('取消')}</button>
                  </div>
                </div>
              )}
              {model?.installed && (
                <>
                  <Toggle
                    title={tr('用本地模型查找')}
                    desc={tr('找到的按上面对应类型的处理方式办；模型出错时请求不发出')}
                    on={s.model.enabled}
                    disabled={!model.runtime}
                    onChange={(v) => void save({ model: { ...s.model, enabled: v } })}
                  />
                  <div className="hub-setrow">
                    <div className="tx">
                      <b>{tr('把握多大才算')}</b>
                      <span>{tr('越高越少误遮，也越容易漏')}</span>
                    </div>
                    <Select
                      className="field"
                      value={String(s.model.minScore)}
                      aria-label={tr('把握多大才算')}
                      onValueChange={(v) => void save({ model: { ...s.model, minScore: Number(v) } })}
                      options={['0.6', '0.7', '0.8', '0.9'].map((v) => ({ value: v, label: `${Math.round(Number(v) * 100)}%` }))}
                    />
                  </div>
                </>
              )}
              {model && !dl && (model.installed || model.runtimeOwn) && (
                <button className="btn sm ghost" onClick={() => void removeModel()}>{model.runtimeOwn ? tr('删除模型和运行库') : tr('删除模型')}</button>
              )}
              {model?.error && <div className="hub-row hub-sml" role="alert" style={{ color: 'var(--err)', marginTop: 6 }}><Icon name="alert" size={13} />{model.error}</div>}
            </div>
          </section>

          <section className="hub-card">
            <div className="hd">
              <h3>{tr('试一试')}</h3>
              <span className="hub-grow" />
              <span className="hub-chip">{tr('不会保存')}</span>
            </div>
            <div className="bd">
              <textarea className="hub-maskbox" value={sample} spellCheck={false} onChange={(e) => setSample(e.target.value)} aria-label={tr('要试的文字')} />
              <div className="hub-row" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => void test()}>{tr('试一试')}</button>
                <span className="hub-muted hub-sml">{tr('展示厂商实际会收到的文本')}</span>
              </div>
              <div className="hub-muted hub-sml" style={{ marginTop: 10 }}>{tr('厂商收到：')}</div>
              {preview ? (
                <>
                  <pre className="hub-maskbox" style={{ marginTop: 4, minHeight: 74, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {preview.text.split(/(\{\{[A-Z_]+_[a-f0-9]{8}\}\})/).map((seg, i) => (i % 2 ? <span className="hub-ph" key={i}>{seg}</span> : <span key={i}>{seg}</span>))}
                  </pre>
                  <div className="hub-row hub-muted hub-sml" style={{ marginTop: 6 }}>
                    <span>{preview.hits.length ? tr('遮掉 {n} 处', { n: preview.hits.filter((h) => h.action === 'redact').length }) : tr('没有发现敏感内容')}</span>
                    <span className="hub-grow" />
                    {preview.blocked && <span style={{ color: 'var(--err)' }}>{tr('这段内容会被拦截，不会发出')}</span>}
                    {!preview.blocked && preview.hits.some((h) => h.action === 'warn') && <span style={{ color: 'var(--warn)' }}>{tr('这段内容会照发，只提醒你')}</span>}
                  </div>
                  {s.model.enabled && <div className="hub-muted hub-sml">{tr('试一试只用规则；本地模型在真正发请求时才跑')}</div>}
                </>
              ) : (
                <div className="hub-maskbox hub-muted" style={{ marginTop: 4, minHeight: 74 }}>{tr('点了「试一试」以后，这里显示替换结果。')}</div>
              )}
            </div>
          </section>

          <section className="hub-card">
            <div className="hd">
              <h3>{tr('脱敏记录（最近 30 天）')}</h3>
              <span className="hub-grow" />
              <span className="hub-chip">{tr('只在本机')}</span>
              {recent.length > 0 && <button className="btn sm ghost" onClick={() => void ask('privacy.records.clear')}>{tr('清空')}</button>}
            </div>
            <div className="bd">
              <div className="hub-table-wrap">
                <table className="hub-table">
                  <thead>
                    <tr>
                      <th>{tr('时间')}</th>
                      <th>{tr('类型')}</th>
                      <th className="num">{tr('次数')}</th>
                      <th>{tr('处理')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r, i) => (
                      <tr key={`${r.ts}-${i}`}>
                        <td className="hub-mono">{new Date(r.ts).toLocaleString(dateLocale(), { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                        <td>{(Object.keys(r.categories) as PrivacyCategory[]).map((c) => categoryName(c)).join('、')}</td>
                        <td className="num hub-mono">{r.count}</td>
                        <td>{r.blocked ? tr('拦截') : r.warned ? tr('只提醒') : tr('脱敏')}</td>
                      </tr>
                    ))}
                    {!recent.length && <tr><td colSpan={4} className="hub-empty-cell">{tr('还没有脱敏记录')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>

      <OtlpCard />
    </div>
  );
}
