import { describe, it, expect } from 'vitest';
import { dutyPlan } from './duty.js';

const o = { nodeBin: '/usr/bin/node', serverEntry: '/app/server/dist/index.js', dataDir: '/home/me/.claude-web', port: 3090, home: '/home/me' };

describe('dutyPlan', () => {
  it('windows: a hidden logon task (wscript → vbs → cmd that sets the env and runs the server)', () => {
    const p = dutyPlan({
      ...o,
      platform: 'win32',
      nodeBin: 'C:\\Program Files\\Claude Web\\Claude Web.exe',
      serverEntry: 'C:\\app\\index.js',
      dataDir: 'C:\\Users\\Jo Smith\\.claude-web',
      home: 'C:\\Users\\Jo Smith',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      user: 'PC\\Jo Smith',
    });
    const xml = p.files.find((f) => f.path.endsWith('duty.xml'))!;
    const cmd = p.files.find((f) => f.path.endsWith('duty.cmd'))!;
    const vbs = p.files.find((f) => f.path.endsWith('duty.vbs'))!;
    expect(cmd.path).toBe('C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.cmd');
    expect(vbs.path).toBe('C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.vbs');
    expect(cmd.content).toContain('set "CLAUDE_WEB_DIR=C:\\Users\\Jo Smith\\.claude-web"');
    expect(cmd.content).toContain('set "PORT=3090"');
    expect(cmd.content).toContain('set "CLAUDE_WEB_STANDALONE=1"');
    expect(cmd.content).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(cmd.content).toContain('"C:\\Program Files\\Claude Web\\Claude Web.exe" "C:\\app\\index.js" >> "C:\\Users\\Jo Smith\\.claude-web\\duty.log" 2>&1');
    expect(cmd.content).not.toContain('CLAUDE_WEB_TOKEN');
    expect(vbs.content).toBe('CreateObject("WScript.Shell").Run """C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.cmd""", 0, False\r\n');
    // a plain /SC ONLOGON needs admin; an XML task whose logon trigger is for this user doesn't
    expect(p.commands[0]).toBe('schtasks /Create /TN "ClaudeWebDuty" /XML "C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.xml" /F');
    expect(xml.content).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>PC\\Jo Smith</UserId></LogonTrigger>');
    expect(xml.content).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml.content).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml.content).toContain('<Command>wscript.exe</Command><Arguments>&quot;C:\\Users\\Jo Smith\\.claude-web\\duty\\duty.vbs&quot;</Arguments>');
    expect(p.uninstall[0]).toBe('schtasks /Delete /TN "ClaudeWebDuty" /F');
  });

  it('macos: a LaunchAgent plist loaded with launchctl', () => {
    const p = dutyPlan({ ...o, platform: 'darwin', env: { CLAUDE_WEB_DIST: '/app/web/dist' } });
    expect(p.files[0].path).toBe('/home/me/Library/LaunchAgents/app.claude-web.duty.plist');
    expect(p.files[0].content).toContain('<string>/app/server/dist/index.js</string>');
    expect(p.files[0].content).toContain('<key>KeepAlive</key>');
    expect(p.files[0].content).toContain('<key>CLAUDE_WEB_DIR</key><string>/home/me/.claude-web</string>');
    expect(p.files[0].content).toContain('<key>PORT</key><string>3090</string>');
    expect(p.files[0].content).toContain('<key>CLAUDE_WEB_DIST</key><string>/app/web/dist</string>');
    expect(p.files[0].content).toContain('<string>/home/me/.claude-web/duty.log</string>');
    expect(p.commands[0]).toBe('launchctl load -w "/home/me/Library/LaunchAgents/app.claude-web.duty.plist"');
    expect(p.uninstall[0]).toBe('launchctl unload -w "/home/me/Library/LaunchAgents/app.claude-web.duty.plist"');
  });

  it('linux: a systemd user unit', () => {
    const p = dutyPlan({ ...o, platform: 'linux', env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(p.files[0].path).toBe('/home/me/.config/systemd/user/claude-web-duty.service');
    expect(p.files[0].content).toContain('ExecStart="/usr/bin/node" "/app/server/dist/index.js"');
    expect(p.files[0].content).toContain('Restart=always');
    expect(p.files[0].content).toContain('Environment="CLAUDE_WEB_DIR=/home/me/.claude-web"');
    expect(p.files[0].content).toContain('Environment="PORT=3090"');
    expect(p.files[0].content).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(p.commands).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now claude-web-duty']);
    expect(p.uninstall).toEqual(['systemctl --user disable --now claude-web-duty']);
  });

  it('never lets the port be 0 (the phone has to find it)', () => {
    const p = dutyPlan({ ...o, platform: 'linux', port: 0 });
    expect(p.files[0].content).toContain('Environment="PORT=3090"');
  });
});
