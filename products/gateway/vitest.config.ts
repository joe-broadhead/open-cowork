import { configDefaults, defineConfig } from 'vitest/config'

// Keep vitest's default include so tests can live anywhere in the repo, but
// exclude stray agent worktree checkouts (.claude/worktrees/*) from being
// globbed into `npm test` / `npm run verify`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // Isolated parallel workers. The suite already isolates every test with a
    // per-test mkdtemp state/config dir, so distinct test files never share a
    // temp path, port, or SQLite file. The old `--maxWorkers=1` pin was retired
    // after two clean full-suite runs at maxWorkers=4 (1129/1129 both times,
    // ~3x faster than serial). `forks` + `isolate: true` keeps each file in its
    // own fully-reset process — parallelism here does NOT weaken isolation.
    pool: 'forks',
    isolate: true,
    // Applied to EVERY invocation (test, coverage, watch) from the config so no
    // single npm script has to re-declare them. The instrumented coverage run is
    // slower than the plain suite, so the 120s per-test and hook timeouts
    // (vs vitest's 5s/10s defaults) keep subprocess, filesystem-heavy setup,
    // and module-graph integration tests from spuriously timing out under
    // full-suite load, and capping at 2 workers bounds CI memory/CPU while
    // keeping isolation intact.
    testTimeout: 120000,
    hookTimeout: 120000,
    maxWorkers: 2,
    minWorkers: 1,
    coverage: {
      // v8 provider (@vitest/coverage-v8 devDep). Emit a human-readable text
      // summary plus machine-readable lcov + json-summary so CI and the
      // coverage ratchet can diff against the checked-in floor.
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Only measure product source; exclude tests, generated output, build
      // scripts, type-only declarations, and config so the ratchet tracks the
      // code that ships rather than the harness around it.
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'dist/**',
        'scripts/**',
        '**/*.config.ts',
      ],
      // Ratchet floors set just under the Vitest 4 / V8 measured baseline
      // (statements 77.98, branches 69.97, functions 83.94, lines 81.62).
      // These prevent
      // regression without failing today; raise them as coverage climbs. Do
      // NOT lower them to make a red build green — add the missing tests.
      thresholds: {
        statements: 77,
        branches: 69,
        functions: 83,
        lines: 81,
      },
    },
  },
})
