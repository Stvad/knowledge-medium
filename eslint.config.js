import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Top-level ignores. ESLint flat config doesn't honor .gitignore unless
  // you opt in (eslint-config-flat-gitignore), so list ephemeral / agent
  // dirs explicitly. .claude/worktrees/ in particular contains full repo
  // copies that shouldn't be re-linted.
  { ignores: ['dist', '.claude/**', '.playwright-mcp/**', 'tmp/**'] },
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
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // The React Compiler rules folded into react-hooks v7. Most are
      // clean and treated as errors. `set-state-in-effect` stays as a
      // warning: the codebase has a handful of legitimate sync-to-prop
      // and async-load patterns that would each need a small refactor
      // (useState-with-key, derived-state, useSyncExternalStore) to
      // resolve cleanly.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
)
