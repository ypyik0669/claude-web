import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { crashTargets, formatErrorReport, toReport, type ErrorReport } from './error-report';

/**
 * Error boundaries: a component that throws takes down only its own region (a tile, a dock panel, one
 * settings section, a popover) instead of the whole window going white.
 *
 * The fallback says what broke, offers 重试 (remount the region) and 复制错误信息, and the error is
 * reported to the server log (`client.log` → stderr → server.log in the desktop build).
 *
 * Dev switch: `__cwCrash('设置 · 模型')` in the console makes every boundary whose area contains that
 * text throw on its next render (`__cwCrash('')` = all of them) — to check a fallback without a real bug.
 */

const CRASH_EVENT = 'cw:crash';
if (typeof window !== 'undefined') {
  (window as any).__cwCrash = (area = '') => window.dispatchEvent(new CustomEvent(CRASH_EVENT, { detail: String(area) }));
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
}

function Thrower({ area }: { area: string }): never {
  throw new Error(`__cwCrash：${area} 的测试错误`);
}

interface Props {
  /** what this region is, shown in the fallback and the log: `设置 · 模型`, `停靠面板 · 终端`… */
  area: string;
  children?: ReactNode;
  /** small inline fallback (popovers, chips) instead of a centred card */
  compact?: boolean;
  /** the whole window: the fallback fills the viewport */
  full?: boolean;
  /** an overlay (modal, palette, viewer): the fallback floats in a corner instead of landing in the layout grid */
  floating?: boolean;
  /** when any of these change the boundary resets by itself (e.g. the settings section id) */
  resetKeys?: unknown[];
  /** extra clean-up on 重试 (close a popover…) */
  onReset?: () => void;
}
interface State { report: ErrorReport | null; crash: boolean; copied: boolean; attempt: number }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { report: null, crash: false, copied: false, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { report: toReport('', error), crash: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const report = toReport(this.props.area, error, info.componentStack);
    this.setState({ report });
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary] ${report.area}: ${report.message}`);
    ws.request({ kind: 'client.log', level: 'error', area: report.area, message: report.message, stack: report.stack, componentStack: report.componentStack, url: location.pathname + location.search.replace(/token=[^&]+/, 'token=…') }).catch(() => {});
  }

  componentDidMount() { window.addEventListener(CRASH_EVENT, this.onCrash); }
  componentWillUnmount() { window.removeEventListener(CRASH_EVENT, this.onCrash); }

  componentDidUpdate(prev: Props) {
    const a = prev.resetKeys ?? [], b = this.props.resetKeys ?? [];
    if (this.state.report && (a.length !== b.length || a.some((x, i) => !Object.is(x, b[i])))) this.reset();
  }

  private onCrash = (e: Event) => {
    if (!this.state.report && crashTargets(String((e as CustomEvent).detail ?? ''), this.props.area)) this.setState({ crash: true });
  };

  reset = () => {
    this.props.onReset?.();
    this.setState((s) => ({ report: null, crash: false, copied: false, attempt: s.attempt + 1 }));
  };

  private copy = () => {
    const r = this.state.report;
    if (!r) return;
    const eng = useStore.getState().engine;
    const version = eng ? `${eng.runtime} ${eng.version ?? '?'}` : undefined;
    void copyText(formatErrorReport(r, { version, url: location.pathname, userAgent: navigator.userAgent })).then(() => this.setState({ copied: true }));
  };

  render() {
    const { report, crash, copied, attempt } = this.state;
    if (!report) {
      // `attempt` remounts the subtree on 重试 even when nothing else changed
      return <ErrorScope key={attempt}>{crash && <Thrower area={this.props.area} />}{this.props.children}</ErrorScope>;
    }
    const firstLine = report.message.split('\n')[0].slice(0, 300);
    const cls = `err-boundary${this.props.compact ? ' compact' : ''}${this.props.full ? ' full' : ''}${this.props.floating ? ' floating' : ''}`;
    return (
      <div className={cls} role="alert" data-area={this.props.area}>
        <div className="eb-head">
          <span className="eb-ic"><Icon name="alert" size={this.props.compact ? 13 : 16} /></span>
          <span className="eb-title">这里出错了</span>
          {!this.props.compact && <span className="eb-area">{this.props.area}</span>}
        </div>
        <div className="eb-msg" title={report.message}>{firstLine}</div>
        <div className="eb-actions">
          <button type="button" className="btn sm" onClick={this.reset}><Icon name="refresh" size={12} /> 重试</button>
          <button type="button" className="btn sm ghost" onClick={this.copy}><Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? '已复制' : '复制错误信息'}</button>
        </div>
      </div>
    );
  }
}

/** Keyed wrapper so 重试 remounts the children with fresh state. */
function ErrorScope({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
