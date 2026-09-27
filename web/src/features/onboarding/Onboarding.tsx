import { modKey } from '@/features/workbench/shortcuts';
import { useEffect, useState } from 'react';
import { THEMES, useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';

/** First-run wizard: engine & login → workspace → theme → optional provider. Sets `onboarded` when done. */
export function Onboarding() {
  const settings = useStore((s) => s.settings);
  const metaLoaded = useStore((s) => s.metaLoaded);
  const engine = useStore((s) => s.engine);
  const workspaces = useStore((s) => s.workspaces);
  const providers = useStore((s) => s.providers);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const setSetting = useStore((s) => s.setSetting);
  const setTheme = useStore((s) => s.setTheme);
  const theme = useStore((s) => s.theme);
  const openSettings = useStore((s) => s.openSettings);
  const toast = useStore((s) => s.toast);
  const [step, setStep] = useState(0);
  const [auth, setAuth] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  // first run only: existing installs (already have a workspace) skip the wizard
  const show = metaLoaded && !settings.onboarded && workspaces.length === 0;
  const checkAuth = () => { setChecking(true); ws.request<any>({ kind: 'config.auth' }).then(setAuth).catch(() => setAuth({ loggedIn: false })).finally(() => setChecking(false)); };
  useEffect(() => { if (show) checkAuth(); }, [show]);
  if (!show) return null;
  const finish = () => void setSetting('onboarded', true);
  const pick = async () => {
    const p = desktop ? await desktop.pickDir() : await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) await addWorkspace(p).catch((e) => toast(e.message));
  };
  const steps = ['引擎与登录', '工作区', '外观', '完成'];
  return (
    <div className="modal-bg" style={{ zIndex: 150 }}>
      <div className="modal onboarding">
        <div className="ob-steps">{steps.map((s, i) => <span key={s} className={clsx(i === step && 'cur', i < step && 'done')}>{i + 1}. {s}</span>)}</div>
        {step === 0 && (
          <>
            <h3>欢迎使用 Claude Web</h3>
            <p>本机的 Claude Code 工作台。先确认引擎和登录状态。</p>
            <div className="kv">
              <span className="k">引擎</span><span>{engine ? `${engine.runtime === 'ccb' ? 'claude-code-best' : 'Claude Code'} v${engine.version ?? '?'}` : '检测中…'}</span>
              <span className="k">登录</span>
              <span>{checking ? '检查中…' : auth?.loggedIn ? `已登录 ${auth.email ?? auth.authMethod ?? ''}` : <>未登录 — <button className="link" onClick={() => useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd: '' }, 'tab')}>打开终端运行 /login</button>，或下一步添加第三方供应商</>}</span>
            </div>
            <div className="sub" style={{ marginTop: 8 }}>{providers.length ? `已有 ${providers.length} 个供应商档案。` : '没有 Claude 账号也可以：在「设置 → 供应商」里填一个兼容 Anthropic / OpenAI 的接口。'}</div>
            <div className="actions"><button className="btn ghost" onClick={checkAuth}>重新检查</button><button className="btn ghost" onClick={() => { finish(); openSettings({ section: 'providers' }); }}>去添加供应商</button><button className="btn primary" onClick={() => setStep(1)}>下一步</button></div>
          </>
        )}
        {step === 1 && (
          <>
            <h3>添加工作区</h3>
            <p>工作区就是一个项目文件夹，会话在里面运行。可以稍后在侧栏添加更多。</p>
            <div className="list">{workspaces.map((w) => <div key={w.id} className="row"><span><Icon name="folder" size={14} /></span><div className="grow"><div>{w.name}</div><div className="sub">{w.path}</div></div></div>)}</div>
            <div className="actions"><button className="btn" onClick={pick}><Icon name="plus" size={13} /> 选择文件夹</button><span className="grow" /><button className="btn ghost" onClick={() => setStep(0)}>上一步</button><button className="btn primary" onClick={() => setStep(2)}>{workspaces.length ? '下一步' : '跳过'}</button></div>
          </>
        )}
        {step === 2 && (
          <>
            <h3>外观</h3>
            <div className="theme-grid">
              {THEMES.map((t) => <button key={t} className={clsx('theme-card', theme === t && 'active')} data-theme={t} onClick={() => setTheme(t)}><span className="sw" /><span>{t}</span></button>)}
              <button className={clsx('theme-card', settings['ui.theme'] === 'system' && 'active')} onClick={() => void setSetting('ui.theme', 'system')}><span className="sw sys" /><span>跟随系统</span></button>
            </div>
            <div className="actions"><button className="btn ghost" onClick={() => setStep(1)}>上一步</button><span className="grow" /><button className="btn primary" onClick={() => setStep(3)}>下一步</button></div>
          </>
        )}
        {step === 3 && (
          <>
            <h3>就绪</h3>
            <ul className="ob-tips">
              <li>输入框直接聊；<b>{modKey}+K</b> 命令面板；<b>{modKey}+,</b> 设置；<b>?</b> 快捷键表。</li>
              <li>会话标签上方有「改动 / Git / 文件 / 搜索 / 定时」工作台标签。</li>
              <li>拖侧栏的会话到窗格边缘可以分屏；<b>Ctrl+D</b> 向右分屏。</li>
              <li>停靠面板里的「任务」看子代理和后台命令，「用量」看 token 与账本。</li>
            </ul>
            <div className="actions"><button className="btn ghost" onClick={() => setStep(2)}>上一步</button><span className="grow" /><button className="btn primary" onClick={finish}>开始使用</button></div>
          </>
        )}
      </div>
    </div>
  );
}
