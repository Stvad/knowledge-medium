import { describe, expect, it } from 'vitest'
import * as Babel from '@babel/standalone'
import { exampleExtensions } from '@/extensions/exampleExtensions'
import * as extensionApi from '@/extensions/api'
import {definitionSeedsFacet} from '@/data/facets'
import {resolveFacetRuntimeSync, type AppExtension} from '@/facets/facet'

const evaluateApiOnlySource = (source: string, filename: string): AppExtension => {
  const compiled = Babel.transform(source, {
    filename,
    presets: ['react', 'typescript'],
    plugins: ['transform-modules-commonjs'],
  }).code
  if (!compiled) throw new Error(`${filename}: Babel returned empty output`)

  const module = {exports: {} as {default?: AppExtension}}
  const requireTemplateImport = (specifier: string): unknown => {
    if (specifier === '@/extensions/api.js') return extensionApi
    throw new Error(`${filename}: unexpected template import ${specifier}`)
  }
  // Babel's CommonJS transform lets this focused test evaluate the exact
  // generated module string while supplying the real public extension API.
  const evaluate = new Function('require', 'module', 'exports', compiled)
  evaluate(requireTemplateImport, module, module.exports)
  if (!module.exports.default) throw new Error(`${filename}: no default export`)
  return module.exports.default
}

// Catches typos in the templated extension sources. Templated strings
// bypass TypeScript's checker, so without this any malformed JSX or
// import would only surface at workspace seed / command-palette
// invocation time.
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

  it('property-bearing examples evaluate and contribute durable definition seeds', () => {
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
      const runtime = resolveFacetRuntimeSync(evaluateApiOnlySource(
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
        changeScope: extensionApi.ChangeScope.BlockDefault,
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
