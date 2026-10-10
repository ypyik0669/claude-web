import { describe, expect, it } from 'vitest';
import { glowing, sendFace } from './send-state';

describe('sendFace: what the composer\'s one round button is right now', () => {
  it('nothing to send: empty; something to send: ready', () => {
    expect(sendFace({ busy: false, canSend: false, working: false })).toBe('empty');
    expect(sendFace({ busy: false, canSend: true, working: false })).toBe('ready');
  });
  it('starting a conversation / uploading: working (the spinner), whatever is in the box', () => {
    expect(sendFace({ busy: false, canSend: false, working: true })).toBe('working');
    expect(sendFace({ busy: false, canSend: true, working: true })).toBe('working');
  });
  it('a turn in flight: the stop square — also with words in the box (they queue, or go as 插话) and during an upload', () => {
    expect(sendFace({ busy: true, canSend: false, working: false })).toBe('running');
    expect(sendFace({ busy: true, canSend: true, working: false })).toBe('running');
    expect(sendFace({ busy: true, canSend: false, working: true })).toBe('running');
  });
});

describe('glowing: the light around the composer', () => {
  it('only while the conversation is really running', () => {
    expect(glowing({ welcome: false, state: 'running', visible: true })).toBe(true);
    for (const state of ['waiting', 'starting', 'idle', 'history', 'closed', 'error', undefined]) expect(glowing({ welcome: false, state, visible: true })).toBe(false);
  });
  it('not on the start page, not on a conversation behind another tab', () => {
    expect(glowing({ welcome: true, state: 'running', visible: true })).toBe(false);
    expect(glowing({ welcome: false, state: 'running', visible: false })).toBe(false);
  });
});
