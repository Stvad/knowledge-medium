import * as Babel from '@babel/standalone'
import {describe, expect, it} from 'vitest'
import {
  describeAuthoringCatalog,
  type AuthoringExample,
} from '@/plugins/agent-runtime/authoringCatalog'
import {getApiSurface} from '@/plugins/agent-runtime/describeRuntime'

// Drift guard for the AUTHORING CATALOG examples.
//
// Catalog examples are how the bridge teaches agents the canonical
// patterns. When they drift from the actual API surface (a renamed
// export, a deleted helper, a TypeScript syntax error), an agent
// faithfully follows the example, the extension breaks at install
// time, and trust in the catalog erodes.
//
// This test sweeps every code example in the catalog and:
//   1. Babel-transpiles it with the same presets the runtime uses
//      (`react`, `typescript`) — catches syntax errors and
//      JSX/TypeScript misuse before any agent is ever exposed to it.
//   2. Parses the transpiled output for `import { ... } from '@/extensions/api.js'`
//      and confirms every named import exists in `getApiSurface()`.
//      Catches the high-frequency "renamed an export, forgot to
//      update the catalog" failure mode.
//
// We don't currently validate imports from other modules
// (`@/components/ui/*`, `@/utils/*`) — those don't have a
// centralized export list. If a renamed component slips through,
// the lint won't catch it; the extension will fail at runtime
// instead. Acceptable for now — the highest-drift surface is the
// api barrel because we explicitly curate it.

const collectExamples = async (): Promise<Array<{path: string, example: AuthoringExample}>> => {
  const apiSurface = await getApiSurface()
  const catalog = describeAuthoringCatalog(apiSurface)
  const examples: Array<{path: string, example: AuthoringExample}> = []

  for (const pattern of catalog.storage.patterns) {
    if (pattern.example) {
      examples.push({
        path: `storage.patterns.${pattern.id}`,
        example: pattern.example,
      })
    }
  }

  for (const guide of catalog.guides) {
    for (const [index, example] of (guide.examples ?? []).entries()) {
      examples.push({
        path: `guides.${guide.id}.examples[${index}] (${example.label})`,
        example,
      })
    }
  }

  // Sanity: there ARE examples to check. If the catalog gets
  // restructured and this empties out silently, the test would
  // give a green light to anything — guard against that.
  if (examples.length === 0) {
    throw new Error('No catalog examples found — the catalog restructured and this test is silently passing')
  }
  return examples
}

// Capture group 1: the optional `type ` keyword on the whole statement.
// Capture group 2: the inside of the braces.
const NAMED_IMPORT_FROM_API_RE =
  /import\s*(type\s+)?\{([^}]+)\}\s*from\s*['"]@\/extensions\/api\.js['"]/g

/** Returns the named *runtime* imports from `@/extensions/api.js`.
 *
 * Type-only imports are skipped — they're erased at runtime, so they
 * don't need to be in `Object.keys(api)`. Both syntaxes are handled:
 *
 *   - `import type {Foo} from '@/extensions/api.js'`   (whole-statement)
 *   - `import {type Foo, bar} from '@/extensions/api.js'`  (inline) */
const parseNamedImportsFromApi = (source: string): string[] => {
  const names = new Set<string>()
  for (const match of source.matchAll(NAMED_IMPORT_FROM_API_RE)) {
    const isTypeOnlyStatement = Boolean(match[1])
    if (isTypeOnlyStatement) continue
    const namesList = match[2] ?? ''
    for (const raw of namesList.split(',')) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      // Inline `type Foo` import — skip; it's erased at runtime.
      if (/^type\s+/.test(trimmed)) continue
      const cleaned = trimmed
        .replace(/\s+as\s+.+$/, '')   // `Foo as Bar` form — original name is what the api exports
        .trim()
      if (cleaned) names.add(cleaned)
    }
  }
  return [...names]
}

describe('authoring catalog example drift guard', () => {
  it('every example transpiles cleanly through Babel (react + typescript presets)', async () => {
    const examples = await collectExamples()
    const failures: string[] = []
    for (const {path, example} of examples) {
      try {
        const transpiled = Babel.transform(example.code, {
          filename: `${path}.tsx`,
          presets: ['react', 'typescript'],
        }).code
        if (!transpiled) {
          failures.push(`${path}: Babel returned empty output`)
        }
      } catch (error) {
        failures.push(`${path}: ${(error as Error).message}`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('every `@/extensions/api.js` named import in an example exists on the api barrel', async () => {
    const apiSurface = await getApiSurface()
    const exportSet = new Set(apiSurface.exports)
    const examples = await collectExamples()

    const missing: Array<{path: string, name: string}> = []
    for (const {path, example} of examples) {
      const names = parseNamedImportsFromApi(example.code)
      for (const name of names) {
        if (!exportSet.has(name)) {
          missing.push({path, name})
        }
      }
    }

    expect(
      missing,
      missing.map(({path, name}) => `${path} imports '${name}' from @/extensions/api.js, but it isn't exported`).join('\n'),
    ).toEqual([])
  })

  it('parseNamedImportsFromApi extracts runtime imports across syntaxes (skipping types)', () => {
    // Self-test for the regex — if this breaks, the drift guard above
    // would silently miss imports OR falsely flag type-only ones.
    const cases: Array<{source: string, expected: string[]}> = [
      {source: `import {foo} from '@/extensions/api.js'`, expected: ['foo']},
      {source: `import { foo, bar } from '@/extensions/api.js'`, expected: ['foo', 'bar']},
      {
        source: `import {\n  foo,\n  bar,\n  baz,\n} from '@/extensions/api.js'`,
        expected: ['foo', 'bar', 'baz'],
      },
      {source: `import {foo as fooAlias} from '@/extensions/api.js'`, expected: ['foo']},
      // Whole-statement type-only import — entirely skipped (types are erased at runtime).
      {source: `import type {Foo} from '@/extensions/api.js'`, expected: []},
      // Inline `type Foo` — only the type name is skipped, runtime ones stay.
      {source: `import {foo, type Bar} from '@/extensions/api.js'`, expected: ['foo']},
      // Imports from other modules are ignored.
      {source: `import {Button} from '@/components/ui/button.js'`, expected: []},
    ]
    for (const {source, expected} of cases) {
      expect(parseNamedImportsFromApi(source).sort()).toEqual(expected.slice().sort())
    }
  })
})
