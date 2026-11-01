// The prerecorded bits the chapter cards show: the same cart.ts fix as the README's pictures (scripts/lib/demo.cjs).
export const TURN_STEPS = ['Read src/cart.ts', 'Edit src/cart.ts', 'Edit tests/cart.test.ts', 'Bash npm test'];

export const TEST_OUTPUT = [' ✓ tests/cart.test.ts (2)', ' ✓ tests/orders.test.ts (12)', '', ' Test Files  2 passed (2)', '      Tests  14 passed (14)'].join('\n');

export interface DiffFile { file: string; lines: { kind: 'ctx' | 'add' | 'del'; text: string }[] }
export const DIFF: DiffFile[] = [
  {
    file: 'src/cart.ts',
    lines: [
      { kind: 'ctx', text: 'export function applyCoupon(total: number, percent: number): number {' },
      { kind: 'del', text: '  return total - total * (percent / 100);' },
      { kind: 'add', text: '  const discount = Math.round(total * percent) / 100;' },
      { kind: 'add', text: '  return Math.round((total - discount) * 100) / 100;' },
      { kind: 'ctx', text: '}' },
    ],
  },
  {
    file: 'tests/cart.test.ts',
    lines: [
      { kind: 'ctx', text: '  });' },
      { kind: 'add', text: '' },
      { kind: 'add', text: '  it("rounds a percent coupon to whole cents", () => {' },
      { kind: 'add', text: '    expect(total([{ sku: "mug", price: 19.99, qty: 1 }], 15)).toBe(16.99);' },
      { kind: 'add', text: '  });' },
      { kind: 'ctx', text: '});' },
    ],
  },
];

export function diffStat(d: DiffFile[]): { add: number; del: number } {
  let add = 0, del = 0;
  for (const f of d) for (const l of f.lines) { if (l.kind === 'add') add++; if (l.kind === 'del') del++; }
  return { add, del };
}
