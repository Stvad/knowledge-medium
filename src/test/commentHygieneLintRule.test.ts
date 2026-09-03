import { RuleTester } from 'eslint'
import { describe } from 'vitest'
import tseslint from 'typescript-eslint'
// @ts-expect-error no declaration file for the local rule module
import commentHygiene from '../../eslint-rules/comment-hygiene.js'

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

describe('comment-hygiene ESLint rules', () => {
  ruleTester.run('no-invisible-jsdoc', commentHygiene.rules['no-invisible-jsdoc'], {
    valid: [
      { code: `/** doc */\nexport const x = 1` },
      // TypeScript attaches across a blank line and across `//` lines — these must stay legal.
      { code: `/** doc */\n\nexport const x = 1` },
      { code: `/** doc */\n// a plain note\nexport const x = 1` },
      // A file overview before the imports is a header, not a doc of the import.
      { code: `/** overview */\n\nimport { y } from './y'\nexport const x = y` },
      { code: `interface I {\n  /** a */\n  a: string\n}` },
      { code: `const f = (\n  /** the id */ id: string,\n) => id` },
      { code: `const el = <div>{/** jsx note */}</div>`, filename: 'x.tsx' },
      // Standalone JSDoc declarations stack legitimately.
      { code: `/** @typedef {string} Id */\n/** @callback Cb */\n/** the doc */\nexport const x = 1` },
    ],
    invalid: [
      {
        code: `/** first */\n/** second */\nexport const x = 1`,
        errors: [{ messageId: 'shadowed' }],
      },
      {
        code: `/** first */\n\n/** second */\nexport const x = 1`,
        errors: [{ messageId: 'shadowed' }],
      },
      {
        code: `/** overview after imports */\n/** doc */\nexport const x = 1`,
        errors: [{ messageId: 'shadowed' }],
      },
      {
        code: `interface I {\n  a: string\n  /** dangling */\n}`,
        errors: [{ messageId: 'nothing' }],
      },
      {
        code: `export const x = 1\n/** trailing */\n`,
        errors: [{ messageId: 'nothing' }],
      },
      {
        // A brace pair alone is not the JSX exemption.
        code: `function empty() { /** dangling */ }`,
        errors: [{ messageId: 'nothing' }],
      },
    ],
  })

  ruleTester.run('no-review-provenance', commentHygiene.rules['no-review-provenance'], {
    valid: [
      { code: `// filter inside the query, before the LIMIT (#404)\nconst x = 1` },
      { code: `/** Name hygiene: docs/properties-as-blocks-migration.html §7. */\nconst x = 1` },
      { code: `// three rounds of the loop, then settle\nconst x = 1` },
      { code: `// round 2 of the handshake re-sends the nonce\nconst x = 1` },
      // The escape hatch: the directive itself is never scanned, and it suppresses the line below.
      { code: `// eslint-disable-next-line rule-to-test/no-review-provenance -- the PR is the only spec\n// see PR #12 for the shape\nconst x = 1` },
    ],
    invalid: [
      { code: `// name hygiene (PR #288 §7)\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
      { code: `// found by Codex review on PR #427\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
      { code: `/** see PR #447 review comment 3676752542 */\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
      { code: `// a later merge rewrote it (#688 review round 2)\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
      { code: `// what schedules the re-parse (round 7, P2)\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
      { code: `// see commit 429fd4b2\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
      { code: `// reviewer P2 asked for the guard\nconst x = 1`, errors: [{ messageId: 'provenance' }] },
    ],
  })
})
