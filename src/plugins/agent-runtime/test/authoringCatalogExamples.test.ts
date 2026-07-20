import * as Babel from '@babel/standalone'
import {describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {resolveFacetRuntimeSync, type AppExtension} from '@/facets/facet'
import {
  buildExampleRequire,
  parseNamedImports,
  unknownCatalogImports,
} from '@/test/exampleModuleResolver'
import {
  describeAuthoringCatalog,
  type AuthoringExample,
} from '@/plugins/agent-runtime/authoringCatalog'

// Drift guard for the AUTHORING CATALOG examples.
//
// Catalog examples are how the bridge teaches agents the canonical patterns.
// When they drift from the actual API surface (a renamed export, a deleted
// helper, a TypeScript syntax error), an agent faithfully follows the example,
// the extension breaks at install time, and trust in the catalog erodes.
//
// This test sweeps every code example in the catalog and:
//   1. Babel-transpiles it with the same presets the runtime uses
//      (`react`, `typescript`) — catches syntax errors and JSX/TypeScript
//      misuse before any agent is ever exposed to it.
//   2. Parses every `import { ... } from '@/…'` and, for each specifier that
//      is a curated-API module (`apiCatalog.ts`), confirms every imported name
//      (runtime OR type) is one the catalog lists for that module. Catches the
//      high-frequency "renamed/moved an export, forgot to update the catalog"
//      failure mode — now across ALL curated modules, not just a single barrel.
//
// Imports from modules the catalog does NOT curate (`@/components/ui/*`,
// `@/hooks/*`, `react`) are not validated here — those have no centralized
// export list; a renamed component would surface at runtime instead.

const collectExamples = (): Array<{path: string, example: AuthoringExample}> => {
  const catalog = describeAuthoringCatalog()
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

  // Sanity: there ARE examples to check. If the catalog gets restructured and
  // this empties out silently, the test would give a green light to anything.
  if (examples.length === 0) {
    throw new Error('No catalog examples found — the catalog restructured and this test is silently passing')
  }
  return examples
}

const evaluateCompleteExample = async (source: string, filename: string): Promise<AppExtension> => {
  const compiled = Babel.transform(source, {
    filename,
    presets: ['react', 'typescript'],
    plugins: ['transform-modules-commonjs'],
  }).code
  if (!compiled) throw new Error(`${filename}: Babel returned empty output`)

  const module = {exports: {} as {default?: AppExtension}}
  const requireExampleImport = await buildExampleRequire(source)
  const evaluate = new Function('require', 'module', 'exports', compiled)
  evaluate(requireExampleImport, module, module.exports)
  if (!module.exports.default) throw new Error(`${filename}: no default export`)
  return module.exports.default
}

describe('authoring catalog example drift guard', () => {
  it('every example transpiles cleanly through Babel (react + typescript presets)', () => {
    const examples = collectExamples()
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
  }, 20_000)

  it('every named import from a curated-API module exists in the catalog', () => {
    const examples = collectExamples()

    const missing: Array<{path: string, specifier: string, name: string}> = []
    for (const {path, example} of examples) {
      for (const {specifier, name} of unknownCatalogImports(example.code)) {
        missing.push({path, specifier, name})
      }
    }

    expect(
      missing,
      missing.map(({path, specifier, name}) => `${path} imports '${name}' from ${specifier}, but the catalog doesn't list it`).join('\n'),
    ).toEqual([])
  })

  it('every property-bearing example uses block-owned definition seeds', () => {
    const examples = collectExamples()
    const expectedPaths = [
      'guides.block-backed-config.examples[0] (Define a prefs type and read/write a setting)',
      'storage.patterns.settings-via-property-editor-override',
      'storage.patterns.user-prefs-config',
    ].sort()
    const propertyExamples = examples.filter(({example}) =>
      /seedProperty\s*\(|\bdefineProperty\s*\(|propertySchemasFacet/.test(example.code),
    )
    expect(propertyExamples.map(({path}) => path).sort()).toEqual(expectedPaths)

    for (const {path, example} of propertyExamples) {
      const declarationCount = example.code.match(/seedProperty\(\{/g)?.length ?? 0
      const dynamicKeyCount = example.code.match(
        /seedKey:\s*extensionPropertySeedKey\(/g,
      )?.length ?? 0
      const contributionCount = example.code.match(
        /definitionSeedsFacet\.of\(/g,
      )?.length ?? 0

      expect(declarationCount, `${path}: expected at least one seeded declaration`)
        .toBeGreaterThan(0)
      expect(dynamicKeyCount, `${path}: every declaration needs a block-owned key`)
        .toBe(declarationCount)
      expect(contributionCount, `${path}: every declaration needs a seed contribution`)
        .toBe(declarationCount)
      expect(example.code, `${path}: legacy ambient schemas must stay absent`)
        .not.toContain('propertySchemasFacet')
      expect(example.code, `${path}: legacy property constructors must stay absent`)
        .not.toMatch(/\bdefineProperty\s*\(/)
    }
  })

  it('the complete settings example evaluates and contributes definition seeds', async () => {
    const examples = collectExamples()
    const match = examples.find(({path}) =>
      path === 'storage.patterns.settings-via-property-editor-override',
    )
    expect(match).toBeDefined()

    const runtime = resolveFacetRuntimeSync(await evaluateCompleteExample(
      match!.example.code,
      'settings-via-property-editor-override.tsx',
    ))
    expect(runtime.read(definitionSeedsFacet)).toEqual([
      expect.objectContaining({
        seedKey: '@extension/property/auto-sync',
        revision: 1,
        name: 'readwise:autoSync',
        presetId: 'boolean',
        defaultValue: false,
        changeScope: ChangeScope.UserPrefs,
      }),
      expect.objectContaining({
        seedKey: '@extension/property/interval-minutes',
        revision: 1,
        name: 'readwise:intervalMinutes',
        presetId: 'number',
        defaultValue: 60,
        changeScope: ChangeScope.UserPrefs,
      }),
    ])
  })

  it('parseNamedImports extracts names across modules and syntaxes', () => {
    // Self-test for the regex — if this breaks, the drift guard above would
    // silently miss imports or mis-attribute them.
    const source = [
      `import { foo, bar as baz } from '@/extensions/core.js'`,
      `import {`,
      `  ChangeScope, type PropertyEditorProps,`,
      `} from '@/data/api/index.js'`,
      `import type { Facet } from '@/facets/facet.js'`,
      `import { Button } from '@/components/ui/button.js'`,
    ].join('\n')
    expect(parseNamedImports(source)).toEqual([
      {specifier: '@/extensions/core.js', name: 'foo'},
      {specifier: '@/extensions/core.js', name: 'bar'},
      {specifier: '@/data/api/index.js', name: 'ChangeScope'},
      {specifier: '@/data/api/index.js', name: 'PropertyEditorProps'},
      {specifier: '@/facets/facet.js', name: 'Facet'},
      {specifier: '@/components/ui/button.js', name: 'Button'},
    ])
  })
})
