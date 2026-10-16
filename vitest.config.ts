import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    testTimeout: process.env.CI ? 60_000 : 20_000,
    // Git worktrees (git-ignored) carry their own copy of the tests.
    exclude: [...configDefaults.exclude, '.worktrees/**', '.claude/**'],
    // A loaded CI runner can starve a polling test for a few seconds; a real failure fails all three tries.
    retry: process.env.CI ? 2 : 0,
  },
})
