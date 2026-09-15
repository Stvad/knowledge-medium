import { describe, expect, it } from 'vitest'
import * as Babel from '@babel/standalone'
import { exampleExtensions } from '@/extensions/exampleExtensions'
import { describeAuthoringCatalog } from '@/plugins/agent-runtime/authoringCatalog'
import { ChangeScope } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { evaluateExampleModule, fixtureHygieneProblems, unknownCatalogImports } from '@/test/exampleModuleResolver'

/** The example-extension fixture files, as source text — the same `?raw`
 *  inlining exampleExtensions.ts itself uses, resolved independently so the
 *  two can be compared. */
const fixtureSources = import.meta.glob(
  '/src/extensions/examples/**/*.{ts,tsx}',
  {query: '?raw', import: 'default', eager: true},
) as Record<string, string>

/** Named imports that survive to RUNTIME — `import type {...}` statements and
 *  inline `type X` specifiers are erased by Babel, so asserting them against a
 *  module namespace would fail for correct code. */
const runtimeNamedImports = (source: string): Array<{specifier: string, name: string}> => {
  const out: Array<{specifier: string, name: string}> = []
  // Optional default clause: `import React, {useState} from 'react'` was
  // skipped entirely by the brace-immediately-after-import form.
  const statement = /import\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(statement)) {
    if (match[1]) continue                       // `import type { … }` — all erased
    for (const raw of (match[2] ?? '').split(',')) {
      const specifier = raw.trim()
      if (!specifier || /^type\s/.test(specifier)) continue   // inline `type X`
      const name = specifier.replace(/\s+as\s+.+$/, '').trim()
      if (name) out.push({specifier: match[3] ?? '', name})
    }
  }
  return out
}

// Catches typos in the example extension sources. These are seeded into a
// fresh workspace and executed by the `insert_example_extensions` action, so
// a bug here is a broken tutorial. As of PR #compiled-authoring-examples each
// entry's `source` is `?raw`-inlined from a real file under
// src/extensions/examples/, so `pnpm run check` compiles and lints it like
// any other app module — the drift guard below pins that no one can slip an
// inline string back in.
describe('exampleExtensions — templated sources', () => {
  it('every example is the verbatim text of a compiled fixture file under examples/', () => {
    // The load-bearing invariant: an example the gate does NOT compile is an
    // example that ships broken. Both directions are checked — an
    // exampleExtensions entry built from an inline string fails the first
    // assertion, a fixture nothing surfaces (dead file, never read by a
    // workspace) fails the second.
    const byText = new Map(
      Object.entries(fixtureSources).map(([path, source]) => [source.trimEnd(), path]),
    )
    expect(byText.size, 'no fixture files found under src/extensions/examples/').toBeGreaterThan(0)

    const used = new Set<string>()
    const uncompiled: string[] = []
    for (const {id, source} of exampleExtensions) {
      const fixture = byText.get(source)
      if (fixture) used.add(fixture)
      else uncompiled.push(id)
    }

    expect(
      uncompiled,
      `${uncompiled.join(', ')} — example source must be the text of a file under ` +
      'src/extensions/examples/ (imported with ?raw), not an inline string',
    ).toEqual([])
    expect(
      [...byText.values()].filter(path => !used.has(path)),
      'fixture file compiled but never surfaced by exampleExtensions',
    ).toEqual([])
    // Byte-identical fixtures would collide in the text-keyed map above, so
    // one could sit unreferenced while its twin covers for it.
    expect(byText.size, 'two fixture files have identical text').toBe(
      Object.keys(fixtureSources).length,
    )

    // Specifier form and suppression comments — the two things tsc cannot
    // check about a fixture. Shared with the other example family so a fix
    // lands once; see fixtureHygieneProblems for why each rule exists.
    const {badSpecifiers, badSuppressions} = fixtureHygieneProblems(fixtureSources)
    expect(badSpecifiers, badSpecifiers.join('\n')).toEqual([])
    expect(
      badSuppressions,
      `${badSuppressions.join(', ')} — a fixture must not suppress the checks`,
    ).toEqual([])
  })

  it('the fixture files stay out of the discoverable module/component lists', () => {
    // They live under src/extensions/** so the gate compiles them, which also
    // puts them in reach of the authoring catalog's module-index glob. They
    // are seeded-workspace tutorials, not an API an extension should import —
    // surfacing them would offer e.g. `@/extensions/examples/helloRenderer.js`
    // as something to import.
    const catalog = describeAuthoringCatalog()
    const leaked = [
      ...catalog.modules.map(module => module.importPath),
      ...catalog.components.map(component => component.importPath),
    ].filter(path => path.includes('/extensions/examples/'))
    expect(leaked).toEqual([])
  })

  it('all templated sources transpile via Babel (react + typescript) without error', () => {
    for (const {id, source} of exampleExtensions) {
      expect(() =>
        Babel.transform(source, {
          filename: `${id}.tsx`,
          presets: ['react', 'typescript'],
        }),
        `${id} should transpile`,
      ).not.toThrow()
    }
  })

  it('every named import from a curated-API module exists in the catalog', () => {
    // The barrel was retired; each source imports from real modules. Guard
    // against a renamed/moved export leaving a seeded example dangling — it
    // would break at workspace-seed time, not in CI.
    const missing: Array<{id: string, specifier: string, name: string}> = []
    for (const {id, source} of exampleExtensions) {
      for (const {specifier, name} of unknownCatalogImports(source)) {
        missing.push({id, specifier, name})
      }
    }
    expect(
      missing,
      missing.map(({id, specifier, name}) => `${id} imports '${name}' from ${specifier}, but the catalog doesn't list it`).join('\n'),
    ).toEqual([])
  })

  it('every example module evaluates and every value import really exists', async () => {
    // These are not documentation: `insertExampleExtensionsUnder` seeds them
    // into a workspace and the loader EXECUTES them, so a bad import is a
    // broken tutorial rather than a failed build.
    //
    // Two checks, because neither alone is enough. Evaluating proves the
    // module runs and hands back well-formed contributions — but it canNOT
    // see a missing export: the resolver's CommonJS shim reads an absent name
    // as `undefined` instead of throwing the way a real ESM import would
    // (verified by adding a bogus specifier: this test still passed).
    //
    // So the imports are checked directly, against the real module namespace.
    // `unknownCatalogImports` covers only CURATED modules; these fixtures also
    // import `@/components/renderer/*`, where a rename would otherwise reach
    // the tutorial silently.
    const missing: string[] = []
    for (const {id, source} of exampleExtensions) {
      const extension = await evaluateExampleModule(source, `${id}.tsx`)
      expect(extension, `${id} should export an extension`).toBeTruthy()
      expect(() => resolveFacetRuntimeSync(extension), `${id} should resolve`)
        .not.toThrow()

      for (const {specifier, name} of runtimeNamedImports(source)) {
        const namespace = await import(/* @vite-ignore */ specifier.replace(/\.js$/, ''))
        if (!(name in namespace)) missing.push(`${id}: ${name} from ${specifier}`)
      }
    }
    expect(missing, missing.join('\n')).toEqual([])
  }, 30_000)

  it('property-bearing examples evaluate and contribute durable definition seeds', async () => {
    const cases = [
      {
        id: 'hello-renderer',
        seedKey: '@extension/property/hello',
        name: 'user:hello',
        presetId: 'boolean',
        defaultValue: false,
      },
      {
        id: 'emoji-react',
        seedKey: '@extension/property/reactions',
        name: 'user:reactions',
        presetId: 'string-list',
        defaultValue: [],
      },
      {
        id: 'split-layout',
        seedKey: '@extension/property/layout',
        name: 'user:layout',
        presetId: 'optional-string',
        defaultValue: undefined,
        hasExplicitDefault: true,
        encodedDefaultValue: null,
      },
    ] as const

    for (const expected of cases) {
      const definition = exampleExtensions.find(example => example.id === expected.id)
      expect(definition, `${expected.id} example should exist`).toBeDefined()
      const runtime = resolveFacetRuntimeSync(await evaluateExampleModule(
        definition!.source,
        `${expected.id}.tsx`,
      ))
      const seeds = runtime.read(definitionSeedsFacet)

      expect(seeds).toHaveLength(1)
      expect(seeds[0]).toMatchObject({
        seedKey: expected.seedKey,
        revision: 1,
        name: expected.name,
        presetId: expected.presetId,
        defaultValue: expected.defaultValue,
        changeScope: ChangeScope.BlockDefault,
      })
      if ('hasExplicitDefault' in expected) {
        expect(seeds[0]).toMatchObject({
          hasExplicitDefault: expected.hasExplicitDefault,
          encodedDefaultValue: expected.encodedDefaultValue,
        })
      }
    }
  })
})
