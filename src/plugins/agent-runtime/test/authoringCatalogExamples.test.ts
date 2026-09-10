import * as Babel from '@babel/standalone'
import {describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import { extensionApiCatalog } from '@/extensions/apiCatalog'
import {
  evaluateExampleModule,
  parseNamedImports,
  fixtureHygieneProblems,
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
// The primary guard is no longer here: every example is a real source file
// under `src/plugins/agent-runtime/examples/`, so `pnpm run check` compiles
// and lints it like any other app module. The first test below pins exactly
// that — each example's `code` must be the verbatim text of one of those
// files, so nobody can reintroduce an uncompiled inline string.
//
// The rest cover what tsc doesn't:
//   1. Babel-transpiles each example with the presets the *dynamic extension
//      loader* uses (`react`, `typescript`) — the app is compiled by tsgo, so
//      a construct tsgo accepts and Babel rejects would still break an agent
//      that pastes the example into an extension.
//   2. Parses every `import { ... } from '@/…'` and, for each specifier that
//      is a curated-API module (`apiCatalog.ts`), confirms every imported name
//      (runtime OR type) is one the catalog lists for that module. tsc only
//      checks the import RESOLVES; this checks the agent can DISCOVER it —
//      `describe-runtime` is the only module surface an extension author sees.
//
// Imports from modules the catalog does NOT curate (`@/components/ui/*`,
// `@/hooks/*`, `react`) are not validated in (2) — those have no centralized
// export list, and tsc already covers whether they exist.

/** The example fixture files, as source text — the same `?raw` inlining the
 *  catalog itself uses, resolved independently so the two can be compared. */
const fixtureSources = import.meta.glob(
  '/src/plugins/agent-runtime/examples/**/*.{ts,tsx}',
  {query: '?raw', import: 'default', eager: true},
) as Record<string, string>

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

  if (catalog.storage.credentials.example) {
    examples.push({
      path: 'storage.credentials',
      example: catalog.storage.credentials.example,
    })
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

describe('authoring catalog example drift guard', () => {
  it('every example is the verbatim text of a compiled fixture file', () => {
    // The load-bearing invariant: an example the gate does NOT compile is an
    // example that ships broken. Both directions are checked — a catalog entry
    // built from an inline string fails the first assertion, a fixture nothing
    // surfaces (dead file, never read by an agent) fails the second.
    const byText = new Map(
      Object.entries(fixtureSources).map(([path, source]) => [source.trimEnd(), path]),
    )
    expect(byText.size, 'no fixture files found under examples/').toBeGreaterThan(0)

    const used = new Set<string>()
    const uncompiled: string[] = []
    for (const {path, example} of collectExamples()) {
      const fixture = byText.get(example.code)
      if (fixture) used.add(fixture)
      else uncompiled.push(path)
    }

    expect(
      uncompiled,
      `${uncompiled.join(', ')} — example code must be the text of a file under ` +
      'src/plugins/agent-runtime/examples/ (imported with ?raw), not an inline string',
    ).toEqual([])
    expect(
      [...byText.values()].filter(path => !used.has(path)),
      'fixture file compiled but never surfaced by the catalog',
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

  it('the fixtures stay out of the published kernel-types surface too', async () => {
    // The catalog glob keeps them out of `describe-runtime`'s module list, but
    // that is only one of two discovery channels: `pnpm agent types` installs
    // a .d.ts tree into an author's editor, and a fixture emitted there
    // autocompletes as `@/plugins/agent-runtime/examples/settingsDialog.js` —
    // a module the runtime cannot import. Same decision, other surface.
    const {readFileSync} = await import('node:fs')
    const config = readFileSync(
      new URL('../../../../tsconfig.kernel-types.json', import.meta.url),
      'utf8',
    )
    expect(config).toContain('src/**/examples/**')
  })

  it('every API the guide PROSE names still exists', () => {
    // The worked examples compile; the prose around them does not, and it
    // names real APIs an author is told to use. A rename drifts them
    // silently — the same hole the examples used to have, one field over.
    //
    // An explicit list rather than a scan. The scan only saw call-SHAPED
    // mentions, which was 10 of the 21 names actually referenced: every
    // `getOrCreateTypedChild` or `typeSeedsFacet` written in backticks
    // without parens was invisible, and those are the helpers the guides
    // push hardest. It also needed an allowlist of React hooks and JS
    // builtins that would break the gate the day someone wrote `useRef(` in
    // a sentence.
    //
    // NOTE this checks module EXPORTS only. It does not cover member names
    // like `PropertyEditorProps.set` (the prose advertised a `set` prop for
    // as long as the examples were strings, while the real one was
    // `onChange`) — that needs type-level checking this cannot do.
    const PROSE_APIS = [
      'actionsFacet', 'appEffectsFacet', 'appMountsFacet', 'createTypedChild',
      'definePropertyEditorOverride', 'definitionSeedsFacet',
      'extensionTypeSeedKey',
      'getOrCreateKernelPage', 'getOrCreateTypedChild', 'getPluginPrefsBlock',
      'navigate', 'openDialog', 'pluginBlockId', 'propertyEditorOverridesFacet',
      'seedProperty', 'seedType', 'showError', 'showProgress', 'showSuccess',
      'statusProp', 'typeSeedsFacet', 'useRepo',
      // A type, not a runtime export — the guides name it when describing the
      // editor contract, and a rename would drift the prose the same way.
      'PropertyEditorProps',
    ]

    const catalog = describeAuthoringCatalog()
    const prose = JSON.stringify([
      catalog.storage.principles,
      catalog.storage.patterns.map(p => [p.when, p.use, p.modules]),
      catalog.storage.credentials.rule,
      catalog.storage.credentials.currentAffordance,
      catalog.guides.map(g => [
        g.title, g.when, g.principles, g.steps, g.commands, g.afterInstall,
      ]),
    ])
    // exports AND types: the prose names both, and either can be renamed.
    const known = new Set(extensionApiCatalog.flatMap(g => [...g.exports, ...g.types]))

    // Every name the prose relies on is still exported...
    const missing = PROSE_APIS.filter(name => !known.has(name))
    expect(
      missing,
      `${missing.join(', ')} — named in catalog prose but no longer exported`,
    ).toEqual([])

    // ...and the list cannot go stale: each entry must still be mentioned in
    // the prose, so a name dropped from the guides gets dropped from here too.
    //
    // The mention has to be CODE-SHAPED — backticked, or followed by `(`. A
    // bare substring let `navigate` pass on the English verb ("navigate to
    // the prefs block"), so deleting the actual `navigate(repo, …)` mention
    // went unnoticed. If you removed a name deliberately, remove it here too.
    const mentionedAsApi = (name: string): boolean =>
      new RegExp(`\`${name}\\b|\\b${name}\\s*\\(`).test(prose)
    const absent = PROSE_APIS.filter(name => !mentionedAsApi(name))
    expect(
      absent,
      `${absent.join(', ')} — listed here but no longer named as an API in the prose (if that was deliberate, delete the entry)`,
    ).toEqual([])

    // ...and the list cannot be INCOMPLETE either: anything the catalog
    // exports and the prose names must be covered. Without this the guard
    // only protects what someone remembered to list — `TODO_TYPE` and
    // `appEffectsFacet` were both named in prose with no coverage at all.
    const listed = new Set(PROSE_APIS)
    const uncovered = [...new Set(extensionApiCatalog.flatMap(g => [...g.exports, ...g.types]))]
      .filter(name => !listed.has(name) && mentionedAsApi(name))
    expect(
      uncovered,
      `${uncovered.join(', ')} — named as an API in catalog prose but absent from PROSE_APIS`,
    ).toEqual([])
  })

  it('the fixture files stay out of the discoverable module/component lists', () => {
    // They live under src/plugins/** so the gate compiles them, which also puts
    // them in reach of the module-index glob. They are guidance text, not an
    // API an extension should import — surfacing them would offer `@/plugins/
    // agent-runtime/examples/settingsDialog.js` as something to import.
    const catalog = describeAuthoringCatalog()
    const leaked = [
      ...catalog.modules.map(module => module.importPath),
      ...catalog.components.map(component => component.importPath),
    ].filter(path => path.includes('/agent-runtime/examples/'))
    expect(leaked).toEqual([])
  })

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
      'guides.block-backed-config.examples[1] (A plugin root page, and idempotent records under it)',
      'guides.record-grain.examples[0] (A record per block: typed, composed with todo, linked back to its definition)',
      'storage.patterns.imported-record-blocks',
      'storage.patterns.plugin-root-singleton',
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

    const runtime = resolveFacetRuntimeSync(await evaluateExampleModule(
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
    // Babel-transpiles the example and evaluates it against the real curated
    // modules — ~4s of genuine work on a warm cache, so the 5s default leaves
    // no room for CPU contention. Same budget as the transpile sweep above.
  }, 20_000)

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
