import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Each session runs in its own git worktree under `.mjolnir/worktrees/` — a full
    // repo checkout, test files and all. Without this exclude, `vitest run` from the
    // repo root collects those (often stale) copies too, inflating and slowing the
    // suite (and running old code). Keep vitest's own defaults (node_modules, dist, …)
    // and add the worktree tree (#121-adjacent cleanup).
    exclude: [...configDefaults.exclude, '**/.mjolnir/**'],
  },
});
