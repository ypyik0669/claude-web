import { describe, expect, it } from 'vitest';
import { familyIdFor } from './service.js';

describe('a bare model name on a family that lists region-prefixed ids (WorkBuddy)', () => {
  const known = ['global:deepseek-v4.1-flash', 'cn:deepseek-v4.1-flash', 'cn:glm-5.3-flash', 'global:gpt-6-sol'];
  it('maps to the listed id, global first', () => {
    expect(familyIdFor('deepseek-v4.1-flash', known)).toBe('global:deepseek-v4.1-flash');
    expect(familyIdFor('glm-5.3-flash', known)).toBe('cn:glm-5.3-flash');
    expect(familyIdFor('GPT-6-SOL', known)).toBe('global:gpt-6-sol');
  });
  it('none when the family does not have it', () => {
    expect(familyIdFor('claude-opus-5-5', known)).toBeUndefined();
    expect(familyIdFor('flash', known)).toBeUndefined();
  });
});
