import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import blockSubscriptions from './eslint-rules/block-subscriptions.js'

export default tseslint.config(
  // Top-level ignores. ESLint flat config doesn't honor .gitignore unless
  // you opt in (eslint-config-flat-gitignore), so list ephemeral / agent
  // dirs explicitly. .claude/worktrees/ in particular contains full repo
  // copies that shouldn't be re-linted. docs/**/*.ts are design-sketch
  // files (typechecked via docs/tsconfig.json) — they intentionally have
  // unused stub params and let-vs-const looseness so the prose stays
  // readable; ESLint shouldn't gate on them.
  { ignores: ['dist', '**/dist/**', '.claude/**', '.playwright-mcp/**', 'tmp/**', 'docs/**', 'agent-extensions/**'] },
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
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
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
          "CallExpression[callee.object.name='window'][callee.property.name='dispatchEvent'] > NewExpression[callee.name='CustomEvent']",
        message:
          'Opening/toggling UI via window.dispatchEvent(new CustomEvent(...)) is the retired plugin-bus pattern (audit B3). Use openDialog for dialogs/pickers, and a useSyncExternalStore toggle store (createToggleStore) flipped from an action for toggle/open intents. For a genuine broadcast, add `// eslint-disable-next-line no-restricted-syntax -- genuine broadcast: <why>`.',
      }],
    },
  },
  {
    // Tests legitimately dispatch synthetic CustomEvents to drive
    // components, so the B3 guard above doesn't apply to them.
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
)
