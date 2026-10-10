import { describe, expect, it } from 'vitest';
import { KNOWN_APPS, appTokens, describeApp, displayName, grantCovers, knownApp, normalizeApp, pickStartApp, sameExe } from './apps.js';

const OS = 'Microsoft® Windows® Operating System';
const app = (name: string, description = '', product = '') => ({ name, description, product });

const notepad = app('Notepad', 'Notepad', OS);
const explorer = app('explorer', 'Windows Explorer', OS);
const edge = app('msedge', 'Microsoft Edge', 'Microsoft Edge');
const chrome = app('chrome', 'Google Chrome', 'Google Chrome');
const word = app('WINWORD', 'Microsoft Word', 'Microsoft Office');
const excel = app('EXCEL', 'Microsoft Excel', 'Microsoft Office');
const onePassword = app('1Password', '1Password', '1Password');
const notepadPlus = app('notepad++', 'Notepad++', 'Notepad++');
const vscode = app('Code', 'Visual Studio Code', 'Visual Studio Code');
const wechat = app('Weixin', '微信', '微信');
const settings = app('SystemSettings', 'Settings', OS);
const terminal = app('WindowsTerminal', 'WindowsTerminal.exe', 'Windows Terminal');
const calculator = app('CalculatorApp', 'CalculatorApp.exe', 'Microsoft Calculator');
const electron = app('electron', 'Electron', 'Electron');
const cmd = app('cmd', 'Windows Command Processor', OS);
const everything = [notepad, explorer, edge, chrome, word, excel, onePassword, notepadPlus, vscode, wechat, settings, terminal, calculator, electron, cmd];

describe('normalizing names', () => {
  it('folds case, spacing, punctuation and .exe', () => {
    expect(normalizeApp('Claude Web.exe')).toBe('claudeweb');
    expect(normalizeApp('claude-web')).toBe('claudeweb');
    expect(normalizeApp('  Google   Chrome ')).toBe('googlechrome');
    expect(normalizeApp('Notepad++')).toBe('notepad++');
    expect(normalizeApp('ＷＯＲＤ')).toBe('word'); // full-width letters
    expect(normalizeApp('微信')).toBe('微信');
    expect(normalizeApp('')).toBe('');
    expect(normalizeApp('  -- ')).toBe('');
  });

  it('splits a label into words', () => {
    expect(appTokens('Microsoft® Windows® Operating System')).toEqual(['microsoft', 'windows', 'operating', 'system']);
    expect(appTokens('Visual Studio Code')).toEqual(['visual', 'studio', 'code']);
    expect(appTokens('WindowsTerminal.exe')).toEqual(['windowsterminal']);
  });
});

describe('known apps', () => {
  it('Chinese and English names reach the same process', () => {
    for (const [name, target] of [
      ['记事本', notepad], ['Notepad', notepad], ['notepad.exe', notepad],
      ['文件资源管理器', explorer], ['File Explorer', explorer], ['explorer', explorer],
      ['Edge', edge], ['Microsoft Edge', edge], ['msedge', edge],
      ['Chrome', chrome], ['Google Chrome', chrome],
      ['设置', settings], ['Settings', settings],
      ['终端', terminal], ['Windows Terminal', terminal],
      ['计算器', calculator], ['Calculator', calculator],
      ['VS Code', vscode], ['Visual Studio Code', vscode],
      ['Word', word], ['Excel', excel],
      ['微信', wechat], ['WeChat', wechat],
    ] as const) {
      expect(grantCovers(name, target), `${name} → ${target.name}`).toBe(true);
      // and nothing else on this desktop
      for (const other of everything) if (other !== target) expect(grantCovers(name, other), `${name} must not reach ${other.name}`).toBe(false);
    }
  });

  it('the desktop and the taskbar are Explorer; the Start menu is its own thing', () => {
    for (const n of ['Desktop', '桌面', 'Taskbar', '任务栏']) expect(grantCovers(n, explorer), n).toBe(true);
    const start = app('StartMenuExperienceHost', 'Windows Start Experience Host', OS);
    const search = app('SearchHost', 'SearchHost.exe', OS);
    for (const n of ['Start menu', '开始菜单', 'Start']) {
      expect(grantCovers(n, start), n).toBe(true);
      expect(grantCovers(n, search), n).toBe(true);
      expect(grantCovers(n, explorer), n).toBe(false);
    }
    expect(grantCovers('File Explorer', start)).toBe(false);
    // "Desktop" is a word many programs carry: it reaches Explorer and nothing else
    expect(grantCovers('Desktop', app('Telegram', 'Telegram Desktop', 'Telegram Desktop'))).toBe(false);
    expect(grantCovers('Desktop', app('GitHubDesktop', 'GitHub Desktop', 'GitHub Desktop'))).toBe(false);
  });

  it('a known name covers exactly its processes: no look-alikes', () => {
    expect(grantCovers('Word', onePassword)).toBe(false); // 1Password contains the letters w-o-r-d
    expect(grantCovers('Word', app('wordpad', 'Windows Wordpad Application', OS))).toBe(false);
    expect(grantCovers('Notepad', notepadPlus)).toBe(false);
    expect(grantCovers('Code', app('codeium', 'Codeium', 'Codeium'))).toBe(false);
    expect(grantCovers('Edge', app('msedgewebview2', 'Microsoft Edge WebView2', 'Microsoft Edge WebView2'))).toBe(false);
    expect(grantCovers('Explorer', app('iexplore', 'Internet Explorer', 'Internet Explorer'))).toBe(false);
  });

  it('every entry is reachable by each of its names and process names, and none collides with another', () => {
    for (const k of KNOWN_APPS) {
      for (const n of [...k.names, ...k.procs]) expect(knownApp(n), n).toBe(k);
    }
  });

  it('launch targets are plain program names or URI schemes: nothing with a path, a space or an argument', () => {
    for (const k of KNOWN_APPS) if (k.launch) expect(k.launch).toMatch(/^[A-Za-z0-9-]+(\.exe|:)?$/);
  });
});

describe('names that are not in the table', () => {
  it('match the process name, or what the exe calls itself', () => {
    expect(grantCovers('electron', electron)).toBe(true);
    expect(grantCovers('Electron', electron)).toBe(true);
    expect(grantCovers('1Password', onePassword)).toBe(true);
    expect(grantCovers('Notepad++', notepadPlus)).toBe(true);
    expect(grantCovers('Obsidian', app('Obsidian', 'Obsidian', 'Obsidian'))).toBe(true);
    expect(grantCovers('Windows Command Processor', cmd)).toBe(true);
  });

  it('match whole words of the description, in either direction', () => {
    expect(grantCovers('Photoshop', app('Photoshop', 'Adobe Photoshop 2025', 'Adobe Photoshop 2025'))).toBe(true);
    expect(grantCovers('Photoshop', app('ps', 'Adobe Photoshop 2025', ''))).toBe(true);
    expect(grantCovers('Adobe Photoshop 2025 (Beta)', app('ps', 'Adobe Photoshop', ''))).toBe(true);
    expect(grantCovers('Microsoft Office', word)).toBe(true); // the product both belong to
    expect(grantCovers('Microsoft Office', excel)).toBe(true);
    expect(grantCovers('Microsoft Office', edge)).toBe(false);
    // letters inside a word are not a word
    expect(grantCovers('note', app('ONENOTE2', 'Microsoft OneNote', 'Microsoft OneNote'))).toBe(false);
    expect(grantCovers('pass', onePassword)).toBe(false);
  });

  it('from five characters, contain or are contained in the process name', () => {
    expect(grantCovers('Google Chrome Canary', app('chrome', '', ''))).toBe(true);
    expect(grantCovers('steam', app('steamwebhelper', '', ''))).toBe(true);
    expect(grantCovers('slack', app('slack', '', ''))).toBe(true);
    // four letters are not enough for that
    expect(grantCovers('zoom', app('zoomit', '', ''))).toBe(false);
    expect(grantCovers('zoom', app('Zoom', 'Zoom Meetings', 'Zoom'))).toBe(true); // the process is spelled exactly so
  });

  it('Chinese names: contained either way from two characters', () => {
    expect(grantCovers('网易云', app('cloudmusic2', '网易云音乐', '网易云音乐'))).toBe(true);
    expect(grantCovers('百度网盘客户端', app('BaiduNetdisk', '百度网盘', '百度网盘'))).toBe(true);
    expect(grantCovers('盘', app('BaiduNetdisk', '百度网盘', '百度网盘'))).toBe(false);
  });
});

describe('what must not match', () => {
  it('a one- or two-character name matches only what it spells out exactly', () => {
    for (const g of ['a', 'e', 'c', 'x', '1', 'ex', 'ms', 'co', 'wi', 'ch', 'no']) {
      for (const a of everything) expect(grantCovers(g, a), `${g} vs ${a.name}`).toBe(false);
    }
    expect(grantCovers('qq', app('QQ', 'QQ', 'QQ'))).toBe(true);
    expect(grantCovers('et', app('et', 'WPS Spreadsheets', 'WPS Office'))).toBe(true);
    expect(grantCovers('qq', app('QQMusic', 'QQ音乐', 'QQ音乐'))).toBe(false);
  });

  it('nothing matches an empty name, and nothing matches a window without a process name', () => {
    for (const a of everything) {
      expect(grantCovers('', a)).toBe(false);
      expect(grantCovers('   ', a)).toBe(false);
      expect(grantCovers('.exe', a)).toBe(false);
    }
    expect(grantCovers('Notepad', app('', 'Notepad', 'Notepad'))).toBe(false);
  });

  it('a word every program carries matches none of them', () => {
    for (const g of ['Microsoft', 'Windows', 'Microsoft Windows', 'Operating System', 'Microsoft® Windows® Operating System', 'app', 'Application', 'Google', 'system', 'web', 'exe', 'the']) {
      for (const a of everything) expect(grantCovers(g, a), `${g} vs ${a.name}`).toBe(false);
    }
  });

  it('the window title plays no part', () => {
    const titled = { ...chrome, title: 'Notepad' } as any;
    expect(grantCovers('Notepad', titled)).toBe(false);
  });
});

describe('naming an app to the model', () => {
  it('prefers what the exe calls itself, skipping labels a whole family shares', () => {
    expect(displayName(word)).toBe('Microsoft Word');
    expect(displayName(app('explorer', '', OS))).toBe('explorer');
    expect(displayName(app('', '', ''))).toBe('an unknown program');
    expect(describeApp(word)).toBe('"Microsoft Word" (process WINWORD)');
    expect(describeApp(notepad)).toBe('"Notepad"');
  });
});

describe('sameExe', () => {
  it('ignores case, slash direction and quotes', () => {
    expect(sameExe('C:\\Program Files\\Claude Web\\Claude Web.exe', 'c:/program files/claude web/claude web.exe')).toBe(true);
    expect(sameExe('"C:\\a\\b.exe"', 'C:\\a\\b.exe')).toBe(true);
    expect(sameExe('C:\\a\\b.exe', 'C:\\a\\c.exe')).toBe(false);
    expect(sameExe('', '')).toBe(false);
    expect(sameExe(undefined, 'C:\\a\\b.exe')).toBe(false);
  });
});

describe('picking a Start-menu entry', () => {
  const entries = [
    { name: 'Visual Studio Code', appId: 'vsc' }, { name: 'Visual Studio Installer', appId: 'vsi' }, { name: 'Visual Studio 2022', appId: 'vs' },
    { name: '微信', appId: 'wx' }, { name: 'Obsidian', appId: 'obs' }, { name: 'Notepad++', appId: 'npp' },
  ];
  it('the same spelling first, then another name of the same known app, then whole words', () => {
    expect(pickStartApp('obsidian', entries)?.appId).toBe('obs');
    expect(pickStartApp('VS Code', entries)?.appId).toBe('vsc');
    expect(pickStartApp('WeChat', entries)?.appId).toBe('wx');
    expect(pickStartApp('Studio 2022', entries)?.appId).toBe('vs');
    expect(pickStartApp('Visual Studio Installer', entries)?.appId).toBe('vsi');
    expect(pickStartApp('Notepad', entries)).toBeUndefined(); // "Notepad++" is another word
    expect(pickStartApp('', entries)).toBeUndefined();
    expect(pickStartApp('Photoshop', entries)).toBeUndefined();
  });

  it('of several entries a name runs through, the shortest', () => {
    const adobe = [{ name: 'Adobe Photoshop 2025 Uninstaller', appId: 'un' }, { name: 'Adobe Photoshop 2025', appId: 'ps' }];
    expect(pickStartApp('Photoshop', adobe)?.appId).toBe('ps');
  });
});
