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
      // The React Compiler rules folded into react-hooks v7 (refs,
      // immutability, purity, set-state-in-effect/render, etc.) flag real
      // patterns worth migrating, but doing so for the whole codebase is
      // out of scope for this dependency bump. Keep them on as warnings
      // so they're visible but don't block the build.
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
    },
  },
)
