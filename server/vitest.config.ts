import { defineConfig } from 'vitest/config';

// Many suites spawn real processes (mock agents via cmd.exe / node shims, fake CLIs) and tear them
// down with `taskkill /t` in afterEach. Under a loaded full run on Windows that routinely blows past
// vitest's 5 s test / 10 s hook defaults, which showed up as flaky timeouts in opencode-source,
// acp-source and drivers — not as real failures.
export default defineConfig({
  test: {
    // the suites assert the Chinese texts (the interface's key language); a machine in English must not change them
    env: { CLAUDE_WEB_SYSTEM_LANG: 'zh-CN' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'server', include: ['src/**/*.test.ts'], exclude: ['**/node_modules/**', '**/.claude/**', '**/.superpowers/**'] },
      },
    ],
  },
});
