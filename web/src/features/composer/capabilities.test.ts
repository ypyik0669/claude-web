import { describe, expect, it } from 'vitest';
import type { SessionFeatures } from '@shared';
import { CAPABILITIES, FEATURE_KEYS, capabilityTags, featureCount, parseChannels, plusSections, withFeature, withoutTag } from './capabilities';

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
    expect(by).toMatchObject({ chrome: '控制浏览器', computerUse: '操控电脑', coordinator: '协调者模式', proactive: '主动模式' });
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
    const f: SessionFeatures = { computerUse: true, chrome: true, channels: ['plugin:a@m', 'server:b'] };
    const tags = capabilityTags(f);
    expect(tags.map((t) => t.key)).toEqual(['chrome', 'computerUse', 'channels']); // menu order, not object order
    expect(tags.find((t) => t.key === 'channels')?.label).toBe('频道 2');
    expect(withoutTag(f, 'channels').channels).toBeUndefined();
    expect(withoutTag(f, 'chrome')).toEqual({ computerUse: true, channels: ['plugin:a@m', 'server:b'] });
    expect(capabilityTags({})).toEqual([]);
  });

  it('channels: a comma / whitespace list, empty entries dropped', () => {
    expect(parseChannels(' plugin:a@m ,server:b,, ')).toEqual(['plugin:a@m', 'server:b']);
    expect(parseChannels('')).toEqual([]);
  });
});

describe('+ menu sections', () => {
  it('Claude on the welcome page: attachments, the capabilities, the goal, the advanced group', () => {
    const s = plusSections({ claude: true, live: false });
    expect(s.attach.map((a) => a.id)).toEqual(['files', 'folder', 'reference']);
    expect(s.capabilities).toBe(true);
    expect(s.note).toBeUndefined();
    expect(s.goal).toBe(true);
  });
  it('in a running conversation the capabilities say they apply to the next new one', () => {
    expect(plusSections({ claude: true, live: true }).note).toBe('新对话时生效');
  });
  it('other agents: no Claude-only capabilities (the old `!foreign` condition), goals still work', () => {
    const s = plusSections({ claude: false, live: false });
    expect(s.capabilities).toBe(false);
    expect(s.goal).toBe(true);
  });
  it('a session on another machine takes no uploaded files or folders (their paths are on this machine)', () => {
    const s = plusSections({ claude: true, live: true, remote: true });
    expect(s.attach.find((a) => a.id === 'files')?.note).toMatch(/图片/);
    expect(s.attach.find((a) => a.id === 'folder')?.disabled).toBeTruthy();
  });
});
