import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // Default to the `node` environment: most test files here are pure logic
    // (data/markdown/utils/sync/…) and a per-file jsdom instance was the bulk
    // of the suite's wall-clock (the `environment` phase). Files that need a
    // DOM (React component tests, anything touching document/window) opt in
    // with a `// @vitest-environment jsdom` docblock on line 1 — the long-
    // standing per-file convention here (145+ files already annotate). A new
    // `.test.tsx` or DOM-touching test that forgets the docblock fails loudly
    // in node rather than silently passing, which is the intended tripwire.
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['**/*.{test,spec}.{ts,tsx}'],
    maxWorkers: '100%',
    // Node ≥25 ships its own Web Storage: `localStorage`/`sessionStorage`
    // become own keys of globalThis (returning undefined unless node runs with
    // `--localstorage-file`). The jsdom environment skips window keys that
    // already exist on the global, so jsdom's storage never gets installed and
    // every DOM test touching localStorage explodes on `undefined` — and the
    // real jsdom window is unreachable from a setup file (vitest rewires both
    // `window` and `document.defaultView` to the node global). Disabling
    // node's webstorage in the worker processes makes every node version
    // behave like node 24, where jsdom's storage wins. Node ≥22 accepts the
    // flag, so this is a no-op on versions without the new globals.
    execArgv: ['--no-experimental-webstorage'],
    // node_modules + dist are vitest defaults; .claude/worktrees and
    // .codex/worktrees hold full repo copies from agent runs (Claude Code and
    // Codex respectively) whose tests we don't want to re-execute here.
    // agent-extensions are standalone packages with their own dependency
    // installs and Vitest configs, so root collection must not pick up their
    // tests accidentally.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', '.codex/**', 'tmp/**', 'agent-extensions/**'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/setup.ts']
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  }
})
