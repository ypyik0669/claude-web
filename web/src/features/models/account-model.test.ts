import { describe, expect, it } from 'vitest';
import { ACCOUNT_MODEL_KEY, accountKey, accountModelPending, accountModelUpdate, readAccountModel, rememberedAccountModel } from './account-model';

const models = (name: string) => [{ value: 'default', displayName: 'Default (recommended)', description: `Use the default model (currently ${name})` }, { value: 'opus', displayName: 'Opus', description: 'x' }];
const signedIn = { loggedIn: true, email: 'a@example.test', subscriptionType: 'max' };
const other = { loggedIn: true, email: 'b@example.test', subscriptionType: 'pro' };
const signedOut = { loggedIn: false };
const A = accountKey(signedIn);
const B = accountKey(other);

describe('ui.accountModel: the account default by name, kept with its account (re-review M-3)', () => {
  it('the account key: the e-mail, else the plan, hashed (never the address itself); nothing when signed out or unknown', () => {
    const a = accountKey(signedIn)!;
    expect(a).toMatch(/^a[0-9a-f]{8}$/);
    expect(a).not.toContain('example');
    expect(accountKey({ ...signedIn })).toBe(a);
    expect(accountKey(other)).not.toBe(a);
    expect(accountKey({ loggedIn: true, subscriptionType: 'pro' })).toMatch(/^a[0-9a-f]{8}$/);
    expect(accountKey({ loggedIn: true })).toBeUndefined();
    expect(accountKey(signedOut)).toBeUndefined();
    expect(accountKey(null)).toBeUndefined();
  });
  it('reads both shapes: {name, account} and an older bare string', () => {
    expect(readAccountModel({ name: 'Sonnet 5', account: A })).toEqual({ name: 'Sonnet 5', account: A });
    expect(readAccountModel('Opus 5')).toEqual({ name: 'Opus 5', legacy: true });
    expect(readAccountModel('')).toBeUndefined();
    expect(readAccountModel({ name: '' })).toBeUndefined();
    expect(readAccountModel(42)).toBeUndefined();
  });
  it('shown only for the account it was seen on, never when signed out; an older string only while signed in', () => {
    const set = (v: unknown) => ({ [ACCOUNT_MODEL_KEY]: v });
    expect(rememberedAccountModel(set({ name: 'Sonnet 5', account: A }), signedIn)).toBe('Sonnet 5');
    expect(rememberedAccountModel(set({ name: 'Sonnet 5', account: A }), other)).toBeUndefined();
    expect(rememberedAccountModel(set({ name: 'Sonnet 5', account: A }), signedOut)).toBeUndefined();
    expect(rememberedAccountModel(set({ name: 'Sonnet 5', account: A }), null)).toBe('Sonnet 5'); // not checked yet: no conflict
    expect(rememberedAccountModel(set('Opus 5'), signedIn)).toBe('Opus 5');
    expect(rememberedAccountModel(set('Opus 5'), null)).toBeUndefined();
    expect(rememberedAccountModel(set('Opus 5'), signedOut)).toBeUndefined();
  });
  it('written from the conversation whose info just changed, only when it differs for this account; only for a known account', () => {
    const infoA = { agent: 'claude', models: models('Sonnet 5') };
    const infoB = { agent: 'claude', models: models('Opus 5') };
    // a new info names Sonnet 5; stored is someone else's
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, { name: 'Opus 5', account: B }, signedIn)).toEqual({ name: 'Sonnet 5', account: A });
    // the same name for the same account: nothing to write
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, { name: 'Sonnet 5', account: A }, signedIn)).toBeUndefined();
    // an older bare string is rewritten with its account
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, 'Sonnet 5', signedIn)).toEqual({ name: 'Sonnet 5', account: A });
    // only infos that changed: an old conversation naming Opus 5 does not flip it back (no ping-pong)
    expect(accountModelUpdate({ old: { info: infoB }, s1: { info: infoA } }, { old: { info: infoB } }, { name: 'Sonnet 5', account: A }, signedIn)).toBeUndefined();
    // a provider's / another agent's conversation says nothing about the account
    expect(accountModelUpdate({ s1: { info: { ...infoA, providerId: 'p1' } } }, {}, undefined, signedIn)).toBeUndefined();
    expect(accountModelUpdate({ s1: { info: { ...infoA, agent: 'codex' } } }, {}, undefined, signedIn)).toBeUndefined();
    // signed out: never
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, undefined, signedOut)).toBeUndefined();
    // the account not known yet (not checked, or signed in without an e-mail or a plan): nothing written — a name
    // without an account would show for whoever signs in next (re-review n-5)
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, undefined, null)).toBeUndefined();
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, undefined, undefined)).toBeUndefined();
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, undefined, { loggedIn: true })).toBeUndefined();
  });
  it('the login check answering later writes what an open conversation already named, for that account (re-review n-5)', () => {
    const infoA = { agent: 'claude', models: models('Sonnet 5') };
    // the info came while the account was unknown: skipped then …
    expect(accountModelUpdate({ s1: { info: infoA } }, {}, undefined, null)).toBeUndefined();
    // … written when the account is known, even though the info did not change again
    expect(accountModelPending({ s1: { info: infoA } }, undefined, signedIn)).toEqual({ name: 'Sonnet 5', account: A });
    expect(accountModelPending({ s1: { info: infoA } }, { name: 'Sonnet 5', account: A }, signedIn)).toBeUndefined();
    expect(accountModelPending({ s1: { info: infoA } }, undefined, signedOut)).toBeUndefined();
    expect(accountModelPending({}, undefined, signedIn)).toBeUndefined();
  });
});
