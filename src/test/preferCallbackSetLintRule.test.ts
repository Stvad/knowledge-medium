import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// The local ESLint plugin is plain JS because eslint.config.js imports it directly.
// @ts-expect-error no declaration file for the local rule module
import preferCallbackSet from '../../eslint-rules/prefer-callback-set.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2020,
    sourceType: 'module',
  },
})

describe('prefer-callback-set ESLint rule', () => {
  ruleTester.run('prefer-callback-set', preferCallbackSet.rules['prefer-callback-set'], {
    valid: [
      // The intended replacement.
      { code: `const cs = new CallbackSet('x')` },
      // Non-function element types are unaffected.
      { code: `const ids = new Set<string>()` },
      { code: `let pending: Set<number> = new Set()` },
      // A named type reference (even if it aliases a function) does not match —
      // this is exactly CallbackSet's own internal `new Set<Listener<TArgs>>()`,
      // so the rule never self-flags.
      { code: `const listeners = new Set<Listener>()` },
      { code: `type Listeners = Set<MyCallback>` },
    ],
    invalid: [
      {
        code: `const listeners = new Set<() => void>()`,
        errors: [{ messageId: 'useCallbackSet' }],
      },
      {
        code: `const listeners = new Set<(value: number) => void>()`,
        errors: [{ messageId: 'useCallbackSet' }],
      },
      {
        // Type-annotation form (e.g. a class field) is caught too.
        code: `let listeners: Set<() => void>`,
        errors: [{ messageId: 'useCallbackSet' }],
      },
    ],
  })
})
