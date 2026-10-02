import { defineConfig } from 'vitest/config';

/**
 * Tests that measure real time (the relay's pacing at 20 packets/s, floods that must be worked through within a
 * few seconds, link timings with upper bounds). Next to the full parallel run they get starved of CPU and fail with
 * nothing wrong, so they run as their own group after everything else (sequence.groupOrder).
 */
const REAL_TIME = [
  'src/remote/anywhere/core/relay-link.test.ts',
  'src/remote/anywhere/core/signal.test.ts',
  'src/remote/anywhere/core/p2p.test.ts',
];

// Many suites spawn real processes (mock agents via cmd.exe / node shims, fake CLIs) and tear them
// down with `taskkill /t` in afterEach. Under a loaded full run on Windows that routinely blows past
// vitest's 5 s test / 10 s hook defaults, which showed up as flaky timeouts in opencode-source,
// acp-source and drivers — not as real failures.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'server', include: ['src/**/*.test.ts'], exclude: REAL_TIME, sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: 'real-time', include: REAL_TIME, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
