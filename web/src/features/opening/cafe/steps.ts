// 网吧开门's script, pure (steps.test.ts): the cafe opens at night with its rows dark; the first row's lights come on
// (its 网管 at the counter, two customers already at their PCs), someone walks in from the door, then the next rows
// light up one by one. Each step is the whole cafe at that moment, the way the scene takes it (CafeScene.setZones): a
// customer who first shows up once the cafe has people walks in from the door.
import type { SceneBot, SceneZone } from '@/features/office/scene';

/** A row's colour (office/scene.ts AGENT_HEX: amber, teal, pink) and its customers' (lime, blue, violet, orange). */
const ROWS = [
  { key: 'a', letter: 'A', accent: '#fbbf24' },
  { key: 'b', letter: 'B', accent: '#2dd4bf' },
  { key: 'c', letter: 'C', accent: '#f472b6' },
] as const;
const PEOPLE = ['#a3e635', '#60a5fa', '#a78bfa', '#fb923c', '#22d3ee', '#4ade80'];

const lead = (r: number): SceneBot => ({ id: `${ROWS[r].key}|lead`, kind: 'lead', seat: -1, status: 'working', color: ROWS[r].accent, shape: 4, look: 'lead' });
const guest = (r: number, seat: number, n: number): SceneBot => ({ id: `${ROWS[r].key}|${seat}`, kind: 'customer', seat, status: 'working', color: PEOPLE[n % PEOPLE.length], shape: (n % 4) as 0 | 1 | 2 | 3, look: 'guest' });

export interface CafeStep { at: number; zones: SceneZone[] }

/** The steps, `at` seconds after the cafe's first frame (简短: the same at half the time). */
export function cafeSteps(full: boolean): CafeStep[] {
  const k = full ? 1 : 0.5;
  // who is in each row at each step: [row, seats seated from the start]; walkers are added later
  const rowA = [lead(0), guest(0, 1, 0), guest(0, 4, 1)];
  const rowB = [lead(1), guest(1, 0, 2), guest(1, 3, 3)];
  const rowC = [lead(2), guest(2, 2, 4), guest(2, 5, 5)];
  const zone = (r: number, bots: SceneBot[]): SceneZone => ({ key: ROWS[r].key, name: '', letter: ROWS[r].letter, accent: ROWS[r].accent, bots });
  return [
    // dark: nobody yet (the neon sign and the big screen glow in the night)
    { at: 0, zones: [] },
    // the first row lights up
    { at: 0.15 * k, zones: [zone(0, rowA)] },
    // someone walks in from the door, to the first row
    { at: 0.4 * k, zones: [zone(0, [...rowA, guest(0, 2, 3)])] },
    // the second row
    { at: 0.95 * k, zones: [zone(0, [...rowA, guest(0, 2, 3)]), zone(1, rowB)] },
    // the third, and another one walks in
    { at: 1.5 * k, zones: [zone(0, [...rowA, guest(0, 2, 3)]), zone(1, [...rowB, guest(1, 5, 0)]), zone(2, rowC)] },
  ];
}
