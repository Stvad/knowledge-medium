import { describe, expect, it } from 'vitest'
import * as Babel from '@babel/standalone'
import { exampleExtensions } from '@/extensions/exampleExtensions'
import { ChangeScope } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { evaluateExampleModule, unknownCatalogImports } from '@/test/exampleModuleResolver'

// Catches typos in the templated extension sources. Templated strings bypass
// TypeScript's checker, so without this any malformed JSX or import would only
// surface at workspace seed / command-palette invocation time.
describe('exampleExtensions — templated sources', () => {
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
