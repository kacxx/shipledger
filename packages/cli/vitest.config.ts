import { defineConfig } from 'vitest/config';

// Many tests build fixture repositories by running git several times. On a
// busy Windows runner a cold git process can take over a second, so a test
// that builds its fixture in the test body (rather than in a hook, which gets
// 10 s by default) can pass vitest's default 5 s limit without hanging.
// The limits stay finite so a real hang still fails.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
