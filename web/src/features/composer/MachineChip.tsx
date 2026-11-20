// 新对话选机器 (spec 2026-10-16 sessions-env §3, stage E5; the official app's environment picker): on the welcome
// page, where the new conversation runs — this computer, a WSL distro (Windows desktop), or a connected federation
// peer — and 添加 SSH 机器… at the end. The value is one string (composer/machine.ts).
import { useEffect, useRef, useState } from 'react';
import type { PeerInfo, WslDistro } from '@shared';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { Popover } from './Popover';
import { machineOf } from './machine';

export function MachineChip({ peers, wsl, value, onPick, onAddSsh, onInstall, onOpen, hideWhenAlone }: {
  peers: PeerInfo[];
  wsl: WslDistro[];
  value: string;
  onPick: (v: string) => void;
  onAddSsh: () => void;
  onInstall: (distro: string) => void;
  /** the menu opened: the welcome page asks for the distros and checks each */
  onOpen?: () => void;
  /** only drawn when there is another computer — a peer or a WSL distro (redesign 2026-11: 「本机」 joins the folder only then) */
  hideWhenAlone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  // 常开机器 (stage F1) first: 合上电脑也继续
  const usable = peers.filter((p) => p.enabled).sort((a, b) => Number(!!b.alwaysOn) - Number(!!a.alwaysOn));
  useEffect(() => { if (open) onOpen?.(); }, [open]);
  if (hideWhenAlone && !usable.length && !wsl.length && !value) return null;
  const m = machineOf(value);
  const curPeer = m.kind === 'peer' ? usable.find((p) => p.id === m.id) : undefined;
  const label = m.kind === 'wsl' ? tr('WSL · {d}', { d: m.distro }) : curPeer ? curPeer.name : tr('本机');
  const pick = (v: string) => { setOpen(false); onPick(v); };
  return (
    <>
      <button ref={chip} type="button" className={clsx('cchip machine-chip', open && 'open')} aria-haspopup="menu" aria-expanded={open} data-machine={value || 'local'}
        title={tr('新对话在哪台电脑上运行')} onClick={() => setOpen((o) => !o)}>
        <Icon name="monitor" size={14} />
        <span className="cchip-l">{label}</span>
      </button>
      {open && (
        <Popover anchor={chip} onClose={() => setOpen(false)} prefer="up" align="left" className="machine-menu" label={tr('运行在')}>
          <button role="menuitemradio" data-mi aria-checked={m.kind === 'local'} className="cm-it" data-id="machine-local" onClick={() => pick('')}>
            <span className="cm-ck">{m.kind === 'local' && <Icon name="check" size={13} />}</span>
            <span className="cm-tx"><span className="cm-l">{tr('本机')}</span></span>
          </button>
          {wsl.map((d) => {
            const v = `wsl:${d.name}`;
            const on = value === v;
            return (
              <div key={v} className="machine-wsl-row">
                <button role="menuitemradio" data-mi aria-checked={on} className="cm-it" data-id="machine-wsl" data-distro={d.name} onClick={() => pick(v)}>
                  <span className="cm-ck">{on && <Icon name="check" size={13} />}</span>
                  <span className="cm-tx">
                    <span className="cm-l">{tr('WSL · {d}', { d: d.name })}</span>
                    {d.claude === false && <span className="cm-d">{tr('没装 Claude Code')}</span>}
                    {d.claude !== false && d.interop === false && <span className="cm-d">{tr('Windows 互通已关：记忆、联网、操控电脑不可用')}</span>}
                    {d.claude === null && <span className="cm-d">{tr('检查中…')}</span>}
                  </span>
                </button>
                {d.claude === false && (
                  <button type="button" data-mi className="btn sm machine-install" onClick={() => { setOpen(false); onInstall(d.name); }}>{tr('在 WSL 里安装')}</button>
                )}
              </div>
            );
          })}
          {usable.map((p) => {
            const online = p.state === 'online';
            return (
              <button key={p.id} role="menuitemradio" data-mi aria-checked={p.id === value} className="cm-it" disabled={!online} onClick={() => pick(p.id)}>
                <span className="cm-ck">{p.id === value && <Icon name="check" size={13} />}</span>
                <span className="cm-tx">
                  <span className="cm-l">{p.name}</span>
                  <span className="cm-d">{online ? (p.alwaysOn ? tr('常开 · 合上电脑也继续') : tr('已连接')) : tr('现在连不上')}</span>
                </span>
              </button>
            );
          })}
          <div className="menu-sep" />
          <button role="menuitem" data-mi className="cm-it" data-id="machine-add-ssh" onClick={() => { setOpen(false); onAddSsh(); }}>
            <span className="cm-ck"><Icon name="plus" size={13} /></span>
            <span className="cm-tx"><span className="cm-l">{tr('添加 SSH 机器…')}</span></span>
          </button>
        </Popover>
      )}
    </>
  );
}
