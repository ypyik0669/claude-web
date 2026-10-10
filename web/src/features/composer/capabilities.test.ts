import { describe, expect, it } from 'vitest';
import type { SessionFeatures } from '@shared';
import { CAPABILITIES, FEATURE_KEYS, LIVE_CAPS_NOTE, ONE_TIME_KEYS, afterStart, capabilitiesFor, capabilityTags, featureCount, migrateFeatureDefaults, parseChannels, plusMenuIds, plusSections, unavailableKeys, withFeature, withoutTag, usable } from './capabilities';

describe('session capabilities (the old 「功能」 menu, now in +)', () => {
  it('every switch of the old menu is here, in the spec order and groups', () => {
    // the old 功能 menu: chrome, computerUse, coordinator, proactive, brief + the channels field
    expect(FEATURE_KEYS).toEqual(['chrome', 'computerUse', 'coordinator', 'proactive', 'brief']);
    expect(CAPABILITIES.filter((c) => c.group === 'main').map((c) => c.key)).toEqual(['chrome', 'computerUse']);
    expect(CAPABILITIES.filter((c) => c.group === 'advanced').map((c) => c.key)).toEqual(['coordinator', 'proactive', 'brief']);
    for (const c of CAPABILITIES) {
      expect(c.label).toBeTruthy();
      expect(c.desc.length).toBeGreaterThan(4);
      expect(c.title).toBeTruthy(); // the raw name (Claude in Chrome, Computer Use…) stays in the tooltip
    }
  });

  it('uses the spec wording', () => {
    const by = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c.label]));
    expect(by).toMatchObject({ chrome: '控制 Chrome', computerUse: '操控电脑', coordinator: '协调者模式', proactive: '主动模式' });
  });

  it('toggles and counts', () => {
    let f: SessionFeatures = {};
    f = withFeature(f, 'chrome', true);
    f = withFeature(f, 'brief', true);
    expect(featureCount(f)).toBe(2);
    f = withFeature(f, 'chrome', false);
    expect(f.chrome).toBeUndefined();
    expect(featureCount({ ...f, channels: ['server:x'], env: { A: '1' } })).toBe(2); // env is not a capability
  });

  it('open capabilities become removable tags (channels included)', () => {
    const f: SessionFeatures = { brief: true, chrome: true, channels: ['plugin:a@m', 'server:b'] };
    const tags = capabilityTags(f);
    expect(tags.map((t) => t.key)).toEqual(['chrome', 'brief', 'channels']); // menu order, not object order
    expect(tags.find((t) => t.key === 'channels')?.label).toBe('频道 2');
    expect(withoutTag(f, 'channels').channels).toBeUndefined();
    expect(withoutTag(f, 'chrome')).toEqual({ brief: true, channels: ['plugin:a@m', 'server:b'] });
    expect(capabilityTags({})).toEqual([]);
  });

  // 操控电脑 is our own `computer` MCP server, Windows only for now: where the server's machine is not Windows the
  // row stays in the menu to say so, and nothing can turn it on
  it('操控电脑 where the machine the server runs on cannot do it: the row says why, no tag, not counted, not switched on, left out of the defaults', () => {
    for (const env of [undefined, {}, { computer: false }]) {
      const cu = capabilitiesFor(env).find((c) => c.key === 'computerUse')!;
      expect(cu.unavailable).toMatch(/只支持 Windows/);
      expect(cu.unavailable).toMatch(/浏览器/); // where the web part is done instead
      expect(unavailableKeys(env)).toEqual(['computerUse']);
      expect(withFeature({}, 'computerUse', true, env)).toEqual({});
      const stored: SessionFeatures = { computerUse: true, chrome: true };
      expect(capabilityTags(stored, env).map((t) => t.key)).toEqual(['chrome']);
      expect(featureCount(stored, env)).toBe(1);
      expect(usable(stored, env)).toEqual({ chrome: true });
    }
    const same: SessionFeatures = { chrome: true };
    expect(usable(same)).toBe(same); // nothing to drop: the same object (no new value for a selector)
    // the other rows never depend on the machine
    expect(capabilitiesFor({}).filter((c) => c.unavailable).map((c) => c.key)).toEqual(['computerUse']);
  });

  it('操控电脑 on Windows: a switch like the others — and its description says the user is asked first', () => {
    const env = { computer: true };
    const cu = capabilitiesFor(env).find((c) => c.key === 'computerUse')!;
    expect(cu.unavailable).toBeUndefined();
    expect(cu.desc).toMatch(/先问你/);
    expect(cu.title).toMatch(/只对这一个对话开/);
    expect(unavailableKeys(env)).toEqual([]);
    const on = withFeature({ chrome: true }, 'computerUse', true, env);
    expect(on).toEqual({ chrome: true, computerUse: true });
    expect(usable(on, env)).toBe(on);
    expect(capabilityTags(on, env).map((t) => t.label)).toEqual(['控制 Chrome', '操控电脑']);
    expect(featureCount(on, env)).toBe(2);
    expect(withFeature(on, 'computerUse', false, env)).toEqual({ chrome: true });
    expect(withoutTag(on, 'computerUse')).toEqual({ chrome: true });
  });

  it('…asked for anew for every conversation: after one was started with it, the next starts without', () => {
    expect(ONE_TIME_KEYS).toEqual(['computerUse']);
    expect(afterStart({ computerUse: true, chrome: true, channels: ['server:x'] })).toEqual({ chrome: true, channels: ['server:x'] });
    const kept: SessionFeatures = { chrome: true, brief: true };
    expect(afterStart(kept)).toBe(kept);
    // what an older build left in localStorage is taken over without it; what is in meta.json is read as it is
    // (the machine is not known yet there: `usable` leaves out what it cannot do when the defaults are read)
    expect(migrateFeatureDefaults(undefined, JSON.stringify({ computerUse: true, chrome: true }))).toEqual({ value: { chrome: true }, write: true, dropLegacy: true });
    expect(migrateFeatureDefaults({ computerUse: true, chrome: true }, null).value).toEqual({ computerUse: true, chrome: true });
  });

  it('channels: a comma / whitespace list, empty entries dropped', () => {
    expect(parseChannels(' plugin:a@m ,server:b,, ')).toEqual(['plugin:a@m', 'server:b']);
    expect(parseChannels('')).toEqual([]);
  });
});

describe('+ menu sections', () => {
  it('Claude on the welcome page: attachments, editable capabilities, the goal', () => {
    const s = plusSections({ claude: true, live: false });
    expect(s.attach.map((a) => a.id)).toEqual(['files', 'folder', 'reference']);
    expect(s.capabilities).toBe(true);
    expect(s.readOnly).toBe(false);
    expect(s.note).toBeUndefined();
    expect(s.goal).toBe(true);
  });
  it('in a running conversation: the switches show its own state, read-only, and ONE note says changes go to new ones', () => {
    const s = plusSections({ claude: true, live: true });
    expect(s.readOnly).toBe(true);
    expect(s.note).toBe(LIVE_CAPS_NOTE);
    expect(LIVE_CAPS_NOTE).toMatch(/要改请在新对话的 \+ 里设置/);
    expect(LIVE_CAPS_NOTE).not.toMatch(/生效/); // 「…在新对话生效」 read as if this menu changed them
  });
  it('other agents: no Claude-only capabilities (the old `!foreign` condition), goals still work', () => {
    const s = plusSections({ claude: false, live: false });
    expect(s.capabilities).toBe(false);
    expect(s.goal).toBe(true);
  });
  it('a conversation on another machine: no uploaded files or folders, no goal (goals run on this machine)', () => {
    const s = plusSections({ claude: true, live: true, remote: true });
    expect(s.attach.find((a) => a.id === 'files')?.note).toMatch(/图片/);
    expect(s.attach.find((a) => a.id === 'folder')?.disabled).toBeTruthy();
    expect(s.goal).toBe(false);
  });
  it('plusMenuIds: every row id the menu can draw', () => {
    expect(plusMenuIds()).toEqual(['files', 'folder', 'reference', 'chrome', 'computerUse', 'coordinator', 'proactive', 'brief', 'channels', 'goal']);
  });
});

describe('new-conversation capability defaults live in meta.json (ui.featureDefaults)', () => {
  it('stored value wins; a leftover localStorage key is dropped', () => {
    expect(migrateFeatureDefaults({ chrome: true }, '{"brief":true}')).toEqual({ value: { chrome: true }, write: false, dropLegacy: true });
    expect(migrateFeatureDefaults({}, null)).toEqual({ value: {}, write: false, dropLegacy: false });
  });
  it('nothing stored yet: the old cw.lastFeatures is taken over once', () => {
    expect(migrateFeatureDefaults(undefined, '{"chrome":true,"channels":["server:x"]}')).toEqual({ value: { chrome: true, channels: ['server:x'] }, write: true, dropLegacy: true });
  });
  it('garbage in localStorage is dropped, not written', () => {
    expect(migrateFeatureDefaults(undefined, '{oops')).toEqual({ value: {}, write: false, dropLegacy: true });
    expect(migrateFeatureDefaults(undefined, '[1]')).toEqual({ value: {}, write: false, dropLegacy: true });
    expect(migrateFeatureDefaults(null, null)).toEqual({ value: {}, write: false, dropLegacy: false });
  });
});
