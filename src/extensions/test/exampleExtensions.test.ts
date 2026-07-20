import { describe, expect, it } from 'vitest'
import * as Babel from '@babel/standalone'
import { exampleExtensions } from '@/extensions/exampleExtensions'
import { ChangeScope } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet'
import { buildExampleRequire, unknownCatalogImports } from '@/test/exampleModuleResolver'

const evaluateExampleSource = async (source: string, filename: string): Promise<AppExtension> => {
  const compiled = Babel.transform(source, {
    filename,
    presets: ['react', 'typescript'],
    plugins: ['transform-modules-commonjs'],
  }).code
  if (!compiled) throw new Error(`${filename}: Babel returned empty output`)

  const module = {exports: {} as {default?: AppExtension}}
  // The barrel is gone — a template imports from many real modules now, so the
  // require shim preloads whatever each source declares.
  const requireTemplateImport = await buildExampleRequire(source)
  const evaluate = new Function('require', 'module', 'exports', compiled)
  evaluate(requireTemplateImport, module, module.exports)
  if (!module.exports.default) throw new Error(`${filename}: no default export`)
  return module.exports.default
}

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
      const runtime = resolveFacetRuntimeSync(await evaluateExampleSource(
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
