import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { fillComposer } from '@/features/composer/fill';
import { QuickConnect } from '@/features/providers/QuickConnect';
import { loginInTerminal } from '@/features/providers/ConnectModel';
import { currentStep, onboardingSteps, recentFolders } from './steps';

const STEP_LABEL = { login: '接一个模型', project: '选一个项目文件夹' } as const;

/**
 * First-run wizard (spec §5.8), two steps: ① connect a model — skipped when the Claude account is logged in or a
 * provider is set up. Most people starting here have an API key, not a Claude subscription: the quick connect (pick
 * where the key is from, paste it) is the step itself, and the Claude login is the secondary link (logging in in a
 * terminal moves it on by itself); ② pick a project folder — one click on a folder the CLI already worked in, or any
 * folder. Picking one ends the wizard with the start page's composer on that folder and focused, so the first
 * message is one Enter away. Appearance follows the system; the shortcuts are in the 入门清单.
 * Sets `onboarded`; shown only to a first run (no project yet).
 */
export function Onboarding() {
  const settings = useStore((s) => s.settings);
  const metaLoaded = useStore((s) => s.metaLoaded);
  const workspaces = useStore((s) => s.workspaces);
  const providers = useStore((s) => s.providers);
  const sessions = useStore((s) => s.sessions);
  const auth = useStore((s) => s.auth);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [skipped, setSkipped] = useState(false);
  const [checking, setChecking] = useState(false);
  // the first answer about the login has come back (or failed): until then the wizard shows neither step
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  // first run only: existing installs (already have a project) skip the wizard
  const show = metaLoaded && !settings.onboarded && workspaces.length === 0;
  const check = (force = false) => { setChecking(true); void useStore.getState().checkAuth(force).catch(() => null).finally(() => { setChecking(false); setAsked(true); }); };
  useEffect(() => { if (show) check(); }, [show]);
  // back from a terminal where /login was run: ask again (the server shares one answer for 30 s; this one is fresh)
  useEffect(() => {
    if (!show) return;
    const on = () => { if (document.visibilityState === 'visible' && useStore.getState().auth?.loggedIn === false) check(true); };
    window.addEventListener('focus', on);
    return () => window.removeEventListener('focus', on);
  }, [show]);
  const steps = onboardingSteps({ auth, providers: providers.length });
  // not known yet (review 7 M9): a neutral line, not step ① flashing up for someone who is logged in
  const pending = auth === null && providers.length === 0 && !asked;
  const step = pending ? null : currentStep(steps, skipped);
  const folders = useMemo(() => recentFolders(sessions, workspaces.map((w) => w.path)), [sessions, workspaces]);
  if (!show) return null;

  const finish = () => void setSetting('onboarded', true);
  const use = async (p: string) => {
    setBusy(true);
    try {
      await addWorkspace(p);
      try { localStorage.setItem('cw.lastCwd', p); } catch { /* ignore */ }
      finish();
      // the start page's composer: on that folder, ready to type
      setTimeout(() => fillComposer({ cwd: p, focus: true }), 50);
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };
  const browse = async () => {
    const p = desktop ? await desktop.pickDir() : await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) await use(p);
  };
  // the terminal would open behind the wizard: the wizard steps aside (picking the project waits in the start page's
  // 入门清单, and the composer's project chip)
  const login = () => {
    loginInTerminal();
    finish();
  };
  const allSteps: ('login' | 'project')[] = ['login', 'project'];
  return (
    <div className="modal-bg" style={{ zIndex: 150 }}>
      <div className="modal onboarding" role="dialog" aria-label="开始使用" data-step={step ?? 'checking'}>
        <ol className="ob-steps">
          {allSteps.map((s, i) => {
            // the login step is done (logged in, or a provider to use) or was skipped
            const done = !pending && s === 'login' && !steps.includes('login');
            const skippedHere = !pending && s === 'login' && steps.includes('login') && step === 'project';
            return <li key={s} className={clsx(s === step && 'cur', done && 'done', skippedHere && 'skipped')}>{done ? <Icon name="check" size={12} /> : <span className="num">{i + 1}</span>}{STEP_LABEL[s]}{skippedHere ? '（已跳过）' : ''}</li>;
          })}
        </ol>
        {pending && (
          <>
            <h3>欢迎使用 Claude Web</h3>
            <p className="ob-checking" role="status"><span className="spin" aria-hidden />正在检查登录…</p>
          </>
        )}
        {step === 'login' && (
          <>
            <h3>欢迎使用 Claude Web</h3>
            <p>先接一个模型：有 API Key（中转站、DeepSeek、Kimi、智谱……）就在下面填，测试通过就能用。有 Claude Pro / Max 订阅的，也可以直接用 Claude 账号。</p>
            {/* saved → a provider exists → this step drops out of `steps` and the folder step shows */}
            <QuickConnect makeDefault onDone={() => {}} />
            <div className="ob-actions">
              <button className="link" data-ob="login" onClick={login}><Icon name="terminal" size={13} /> 用 Claude 账号登录</button>
              <button className="link" disabled={checking} onClick={() => check(true)}>{checking ? '检查中…' : '已经登录了？重新检查'}</button>
              <span className="grow" />
              <button className="btn ghost" data-ob="skip" onClick={() => setSkipped(true)}>先跳过</button>
            </div>
          </>
        )}
        {step === 'project' && (
          <>
            <h3>选一个项目文件夹</h3>
            <p>Claude 在这个文件夹里读代码、改文件。以后可以在侧栏添加更多项目。</p>
            {folders.length > 0 && (
              <div className="ob-folders" role="list" aria-label="最近用过的文件夹">
                {folders.map((p) => (
                  <button key={p} role="listitem" className="ob-folder" data-ob="folder" disabled={busy} onClick={() => void use(p)} title={p}>
                    <Icon name="folder" size={15} /><span className="grow"><span className="nm">{basename(p)}</span><span className="path">{p}</span></span><Icon name="arrowRight" size={13} />
                  </button>
                ))}
              </div>
            )}
            <div className="ob-actions">
              <button className={clsx('btn', !folders.length && 'primary')} disabled={busy} data-ob="browse" onClick={() => void browse()}><Icon name="folder" size={14} /> {folders.length ? '其它文件夹…' : '选择文件夹…'}</button>
              <span className="grow" />
              <button className="btn ghost" onClick={finish}>以后再说</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
