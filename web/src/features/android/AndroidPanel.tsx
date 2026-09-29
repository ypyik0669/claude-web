import { useEffect, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import type { AndroidStatus } from '@shared';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';

const KEYS: [string, string][] = [['BACK', '4'], ['HOME', '3'], ['RECENTS', '187'], ['POWER', '26'], ['VOL+', '24'], ['VOL−', '25'], ['ENTER', '66']];

/**
 * Android emulator / device preview: live screenshots with tap & swipe, keys, text, apk install, logcat.
 * Optional; needs adb. `visible` is false while the dock is minimised or another tab is showing —
 * the screenshot loop must stop then, or a hidden panel keeps an adb round trip running every 0.9s.
 */
export function AndroidPanel({ visible = true }: { visible?: boolean }) {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<AndroidStatus | null>(null);
  const [serial, setSerial] = useState('');
  const [shot, setShot] = useState<{ png: string; width: number; height: number } | null>(null);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [text, setText] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; t: number } | null>(null);
  const [err, setErr] = useState('');
  const refresh = () => ws.request<AndroidStatus>({ kind: 'android.status' }).then((s) => { setSt(s); setErr(''); if (!serial && s.devices[0]) setSerial(s.devices[0].serial); }).catch((e) => setErr(e.message));
  useEffect(() => { void refresh(); }, []);
  const snap = async () => { if (!serial) return; try { setShot(await ws.request({ kind: 'android.screenshot', serial })); } catch (e: any) { setLive(false); toast(e.message); } };
  useEffect(() => { if (!serial || !live || !visible) return; let stop = false; const loop = async () => { while (!stop) { await snap(); await new Promise((r) => setTimeout(r, 900)); } }; void loop(); return () => { stop = true; }; }, [serial, live, visible]);
  const toDev = (e: React.MouseEvent) => { const img = imgRef.current!; const r = img.getBoundingClientRect(); const sx = (shot?.width ?? img.naturalWidth) / r.width; const sy = (shot?.height ?? img.naturalHeight) / r.height; return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }; };
  const input = async (i: any) => { try { await ws.request({ kind: 'android.input', serial, input: i }); setTimeout(snap, 250); } catch (e: any) { toast(e.message); } };
  const dev = st?.devices.find((d) => d.serial === serial);
  if (!st) return <div className="android"><div className="empty" style={{ padding: 20 }}>{err ? <>检测失败：{err} <button className="btn sm ghost" onClick={refresh}>重试</button></> : '检测 adb…'}</div></div>;
  if (st && !st.adb) return (
    <div className="android"><div className="empty" style={{ padding: 20 }}>
      <div style={{ fontSize: 15, marginBottom: 8 }}>没找到 adb</div>
      <div className="sub">安装 Android Studio 或 <a href="https://developer.android.com/tools/releases/platform-tools" target="_blank" rel="noreferrer">Platform-Tools</a>，把 platform-tools 加进 PATH 或设置 <code>ANDROID_HOME</code>，然后 <button className="btn sm ghost" onClick={refresh}>重新检测</button></div>
    </div></div>
  );
  return (
    <div className="android">
      <div className="android-head">
        <select className="field sm" value={serial} onChange={(e) => setSerial(e.target.value)}>
          <option value="">选择设备…</option>
          {/* an <option> can't hold an icon, so the device kind is spelled out */}
          {st?.devices.map((d) => <option key={d.serial} value={d.serial}>{d.model || d.serial} · {d.emulator ? '模拟器' : 'USB'}{d.state !== 'device' ? ` (${d.state})` : ''}</option>)}
        </select>
        {st && st.avds.length > 0 && <select className="field sm" defaultValue="" onChange={async (e) => { const avd = e.target.value; if (!avd) return; try { await ws.request({ kind: 'android.startEmulator', avd }); toast(`正在启动 ${avd}…`, true); setTimeout(refresh, 8000); } catch (x: any) { toast(x.message); } e.target.value = ''; }}>
          <option value="">启动模拟器…</option>{st.avds.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>}
        <label className="chip"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> 实时</label>
        <button className="icon-btn" title="刷新设备" aria-label="刷新设备" onClick={refresh}><Icon name="refresh" size={14} /></button>
        <span className="grow" />
        <button className="btn sm ghost" disabled={!serial || busy} onClick={async () => { const p = await dlg.prompt('APK 路径', ''); if (!p) return; setBusy(true); try { toast((await ws.request<string>({ kind: 'android.install', serial, apk: p })).trim() || '已安装', true); } catch (e: any) { toast(e.message); } finally { setBusy(false); } }}>安装 APK</button>
        <button className="btn sm ghost" disabled={!serial} onClick={async () => { try { const pk = await ws.request<string[]>({ kind: 'android.packages', serial }); const p = await dlg.prompt('启动应用（包名）', pk[0] ?? '', { message: pk.slice(0, 30).join('\n') }); if (p) await ws.request({ kind: 'android.launchApp', serial, pkg: p }); } catch (e: any) { toast(e.message); } }}>启动应用</button>
        <button className={clsx('btn sm ghost', log !== null && 'active')} disabled={!serial} onClick={async () => { if (log !== null) { setLog(null); return; } try { setLog(await ws.request<string>({ kind: 'android.logcat', serial, lines: 300 })); } catch (e: any) { toast(e.message); } }}>logcat</button>
      </div>
      {!serial && <div className="empty">{st?.devices.length ? '选一台设备' : '没有连接的设备或运行中的模拟器'}</div>}
      {serial && dev?.state !== 'device' && dev && <div className="board-err">设备状态 {dev.state}：{dev.state === 'unauthorized' ? '在设备上允许 USB 调试' : '等待设备就绪'}</div>}
      {serial && (
        <div className="android-body">
          <div className="android-screen">
            {shot ? <img ref={imgRef} src={`data:image/png;base64,${shot.png}`} alt="screen" draggable={false}
              onMouseDown={(e) => { drag.current = { ...toDev(e), t: Date.now() }; }}
              onMouseUp={(e) => { const d = drag.current; drag.current = null; if (!d) return; const p = toDev(e); const dist = Math.hypot(p.x - d.x, p.y - d.y); if (dist < 12) void input({ kind: 'tap', x: p.x, y: p.y }); else void input({ kind: 'swipe', x1: d.x, y1: d.y, x2: p.x, y2: p.y, ms: Math.min(800, Math.max(120, Date.now() - d.t)) }); }} />
              : <div className="empty">等待截图…</div>}
          </div>
          <div className="android-side">
            <div className="keys">{KEYS.map(([l, c]) => <button key={c} className="btn sm ghost" onClick={() => input({ kind: 'key', code: c })}>{l}</button>)}</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input className="field" placeholder="输入文字…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && text) { void input({ kind: 'text', text }); setText(''); } }} />
              <button className="btn sm" disabled={!text} onClick={() => { void input({ kind: 'text', text }); setText(''); }}>发送</button>
            </div>
            <div className="sub">{shot ? `${shot.width}×${shot.height}` : ''} · 点击 = tap，拖动 = swipe</div>
            {log !== null && <div className="android-log"><div style={{ display: 'flex', gap: 6, marginBottom: 4 }}><button className="btn sm ghost" onClick={async () => setLog(await ws.request<string>({ kind: 'android.logcat', serial, lines: 300 }))}>刷新</button><button className="btn sm ghost" onClick={async () => { await ws.request({ kind: 'android.logcat', serial, clear: true }); setLog(''); }}>清空</button></div><pre>{log || '(空)'}</pre></div>}
          </div>
        </div>
      )}
    </div>
  );
}
