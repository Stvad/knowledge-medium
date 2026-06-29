import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import blockSubscriptions from './eslint-rules/block-subscriptions.js'
import preferCallbackSet from './eslint-rules/prefer-callback-set.js'

export default tseslint.config(
  // Top-level ignores. ESLint flat config doesn't honor .gitignore unless
  // you opt in (eslint-config-flat-gitignore), so list ephemeral / agent
  // dirs explicitly. .claude/worktrees/ in particular contains full repo
  // copies that shouldn't be re-linted. docs/**/*.ts are design-sketch
  // files (typechecked via docs/tsconfig.json) — they intentionally have
  // unused stub params and let-vs-const looseness so the prose stays
  // readable; ESLint shouldn't gate on them. **/*.eval.js are agent-bridge
  // eval scripts: the bridge wraps the file body in an async function
  // (top-level `await` + `return` to print back to the CLI), so they aren't
  // standalone ES modules — espree rejects the top-level `return`. Same
  // "runtime code, not a module" carve-out as agent-extensions/**.
  { ignores: ['dist', '**/dist/**', '.claude/**', '.playwright-mcp/**', 'tmp/**', 'docs/**', 'agent-extensions/**', '**/*.eval.js'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      block: blockSubscriptions,
      'callback-set': preferCallbackSet,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Off by design: `only-export-components` guards Vite Fast Refresh, a
      // dev-HMR-only ergonomic. This repo is driven primarily by agents that
      // verify via `yarn vitest` + the live bridge (not by hand-saving in a
      // running dev server), so the rule only emitted ~47 standing warnings
      // that added noise to every lint/check run with no signal. Turn it back
      // on if interactive HMR becomes part of the loop again.
      'react-refresh/only-export-components': 'off',
      // The React Compiler rules folded into react-hooks v7 are treated
      // as errors so new compiler-incompatible patterns fail CI.
      'react-hooks/set-state-in-effect': 'error',
      'block/no-broad-block-subscriptions': ['error', {
        // Renderer selection still re-runs off the full row because
        // canRender/priority predicates can currently inspect block.peek().
        // That path needs a separate dependency API before this exception
        // can be removed.
        allowUseDataIn: ['src/hooks/useRendererRegistry.tsx'],
      }],
      'block/prefer-semantic-block-hooks': ['error', {
        allowIn: ['src/hooks/block.ts'],
      }],
      'block/no-direct-types-prop-writes': ['error', {
        allowIn: [
          'src/data/properties.ts',
          'src/data/typeTagger.ts',
        ],
      }],
      // Audit B3: the untyped window.CustomEvent UI bus was replaced by
      // typed channels. Block its reintroduction — dialogs/pickers go
      // through `openDialog`, toggle/open surfaces through a
      // `createToggleStore` + an action (reached cross-plugin via
      // `runActionById`). A genuine broadcast keeps a CustomEvent but
      // must opt in explicitly with an inline disable + justification
      // (see runtimeEvents.ts / propertyNavigation.ts / agent-runtime).
      'no-restricted-syntax': ['error', {
        selector:
          "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name='dispatchEvent'] > NewExpression[callee.name='CustomEvent']",
        message:
          'Opening/toggling UI via window.dispatchEvent(new CustomEvent(...)) is the retired plugin-bus pattern (audit B3). Use openDialog for dialogs/pickers, and a useSyncExternalStore toggle store (createToggleStore) flipped from an action for toggle/open intents. For a genuine broadcast, add `// eslint-disable-next-line no-restricted-syntax -- genuine broadcast: <why>`.',
      }],
      // Warn (not error) when a Set of function callbacks reinvents the
      // listener add/notify/unsubscribe loop CallbackSet provides. Soft nudge:
      // new code keeps re-rolling `new Set<() => void>()` because nothing points
      // to the shared util. Silence genuine non-listener function-Sets per-site.
      'callback-set/prefer-callback-set': 'warn',
    },
  },
  {
    // Tests legitimately dispatch synthetic CustomEvents to drive
    // components, so the B3 guard above doesn't apply to them. Tests also
    // build throwaway function-Sets for mocks/fakes, so the CallbackSet
    // nudge is off there too.
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
      'callback-set/prefer-callback-set': 'off',
    },
  },
)
