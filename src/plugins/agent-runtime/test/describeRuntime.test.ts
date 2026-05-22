import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetApiSurfaceCacheForTest,
  describeFacets,
  describeRuntime,
  describeRuntimeSummary,
  getApiSurface,
  pingRuntime,
} from '../describeRuntime.ts'
import { defineFacet, resolveFacetRuntime } from '@/extensions/facet.ts'
// Pre-warm `@/extensions/api` so the dynamic import inside
// `getApiSurface()` resolves from cache. Under full-suite parallel
// loads, the cold transform of this barrel + its transitive deps can
// blow past the 5 s per-test timeout (file passes alone, fails ~10%
// of the time when 65+ other test files are competing for the parent
// Vite server's transform queue). Same `.ts` suffix as the dynamic
// import so both share a module-cache key.
import '@/extensions/api.ts'
import type { Repo } from '@/data/repo'
import type { ActionConfig } from '@/shortcuts/types.ts'

beforeEach(() => {
  __resetApiSurfaceCacheForTest()
})

afterEach(() => {
  __resetApiSurfaceCacheForTest()
})

describe('describeFacets', () => {
  it('lists every facet that has at least one contribution', async () => {
    const a = defineFacet({id: 'desc.a'})
    const b = defineFacet({id: 'desc.b'})

    const runtime = await resolveFacetRuntime([
      a.of('alpha', {source: 'src-a'}),
      a.of('beta'),
      b.of('gamma', {source: 'src-b', precedence: 5}),
    ])

    const summary = describeFacets(runtime)
    expect(summary.map((f) => f.id).sort()).toEqual(['desc.a', 'desc.b'])

    const aSummary = summary.find((f) => f.id === 'desc.a')!
    expect(aSummary.contributionCount).toBe(2)
    expect(aSummary.contributions[0]?.source).toBe('src-a')
    expect(aSummary.contributions[1]?.source).toBeUndefined()

    const bSummary = summary.find((f) => f.id === 'desc.b')!
    expect(bSummary.contributions[0]?.source).toBe('src-b')
    expect(bSummary.contributions[0]?.precedence).toBe(5)
  })

  it('summarizes object-shaped contribution values by their interesting keys', async () => {
    const facet = defineFacet({id: 'desc.actions'})
    const runtime = await resolveFacetRuntime([
      facet.of({id: 'foo', description: 'Foo', context: 'global', handler: () => {}}),
    ])

    const [summary] = describeFacets(runtime)
    expect(summary.contributions[0]?.valueSummary).toContain('"id":"foo"')
    expect(summary.contributions[0]?.valueSummary).toContain('"description":"Foo"')
  })

  it('summarizes function values with name', async () => {
    const facet = defineFacet({id: 'desc.fn'})
    const runtime = await resolveFacetRuntime([
      facet.of(function namedFn() {}),
    ])

    const [summary] = describeFacets(runtime)
    expect(summary.contributions[0]?.valueSummary).toMatch(/^\[Function/)
    expect(summary.contributions[0]?.valueSummary).toContain('namedFn')
  })

  it('summarizes primitive values directly', async () => {
    const facet = defineFacet({id: 'desc.prim'})
    const runtime = await resolveFacetRuntime([
      facet.of(42),
      facet.of('hello'),
      facet.of(true),
    ])

    const [summary] = describeFacets(runtime)
    expect(summary.contributions.map((c) => c.valueSummary))
      .toEqual(['42', 'hello', 'true'])
  })

  it('includes shape-defining keys like region and component in the summary', async () => {
    // Mirrors headerItemsFacet: the validator rejects contributions that
    // lack `region`/`component`, so the describe-runtime output has to
    // expose those keys — otherwise agents see only `{id}` and can't tell
    // what shape to author.
    const facet = defineFacet({id: 'desc.headerlike'})
    const Component = function NamedComponent() { return null }
    const runtime = await resolveFacetRuntime([
      facet.of({id: 'h1', region: 'end', component: Component}),
    ])

    const [summary] = describeFacets(runtime)
    const json = summary.contributions[0]!.valueSummary
    expect(json).toContain('"id":"h1"')
    expect(json).toContain('"region":"end"')
    expect(json).toContain('[Function NamedComponent]')
  })

  it('surfaces the facet validator source as a hint about required shape', async () => {
    const facet = defineFacet<{id: string, region: 'start' | 'end'}, unknown>({
      id: 'desc.validated',
      validate: (value): value is {id: string, region: 'start' | 'end'} =>
        typeof value === 'object'
        && value !== null
        && typeof (value as Record<string, unknown>).id === 'string'
        && ((value as Record<string, unknown>).region === 'start'
          || (value as Record<string, unknown>).region === 'end'),
    })
    const runtime = await resolveFacetRuntime([facet.of({id: 'x', region: 'start'})])

    const [summary] = describeFacets(runtime)
    expect(summary.validate).toBeDefined()
    expect(summary.validate).toContain('region')
    expect(summary.validate).toContain('start')
  })

  it('omits validate when the facet has no validator', async () => {
    const facet = defineFacet({id: 'desc.unvalidated'})
    const runtime = await resolveFacetRuntime([facet.of('ok')])

    const [summary] = describeFacets(runtime)
    expect(summary.validate).toBeUndefined()
  })
})

describe('getApiSurface', () => {
  it('returns the @/extensions/api module name and a non-empty exports list', async () => {
    const surface = await getApiSurface()
    expect(surface.module).toBe('@/extensions/api')
    expect(surface.exports.length).toBeGreaterThan(0)
    expect(surface.exports).toContain('defineFacet')
    expect(surface.exports).toContain('actionsFacet')
    expect(surface.exports).toContain('blockRenderersFacet')
    expect(surface.exports).toContain('getUserPrefsBlock')
  })

  it('memoizes — subsequent calls return the same array reference', async () => {
    const first = await getApiSurface()
    const second = await getApiSurface()
    expect(second).toBe(first)
  })
})

describe('describeRuntime', () => {
  const fakeRepo = {
    activeWorkspaceId: 'ws-1',
    user: {id: 'u-1', name: 'Test'},
  } as unknown as Repo

  const makeAction = (id: string, hasBinding: boolean): ActionConfig => ({
    id,
    description: `Description for ${id}`,
    context: 'global',
    handler: () => {},
    ...(hasBinding ? {defaultBinding: {keys: 'mod+x'}} : {}),
  })

  it('produces a compact ping payload without diagnostics', async () => {
    const runtime = await resolveFacetRuntime([])
    const ping = pingRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: true,
      actions: [makeAction('a1', true)],
      renderers: {default: () => null},
    })

    expect(ping).toEqual({
      ok: true,
      activeWorkspaceId: 'ws-1',
      currentUser: {id: 'u-1', name: 'Test'},
      safeMode: true,
    })
    expect(ping).not.toHaveProperty('actions')
    expect(ping).not.toHaveProperty('facets')
    expect(ping).not.toHaveProperty('apiSurface')
  })

  it('produces a curated runtime summary with counts and expansion hints', async () => {
    const a = defineFacet({id: 'summary.a'})
    const b = defineFacet({id: 'summary.b'})
    const runtime = await resolveFacetRuntime([
      a.of('one'),
      a.of('two'),
      b.of('three'),
    ])

    const summary = await describeRuntimeSummary({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [
        makeAction('a1', true),
        makeAction('a2', false),
      ],
      renderers: {default: () => null, custom: () => null},
    })

    expect(summary.activeWorkspaceId).toBe('ws-1')
    expect(summary.commands.baseline).toContain('yarn agent ping')
    expect(summary.commands.diagnostics.some(command =>
      command.startsWith('yarn agent describe-runtime'),
    )).toBe(true)
    expect(summary.capabilities.actions.count).toBe(2)
    expect(summary.capabilities.actions.byContext.global).toBe(2)
    expect(summary.capabilities.actions.examples).toEqual([
      {id: 'a1', description: 'Description for a1', context: 'global'},
      {id: 'a2', description: 'Description for a2', context: 'global'},
    ])
    expect(summary.capabilities.renderers).toEqual({
      count: 2,
      ids: ['default', 'custom'],
    })
    expect(summary.capabilities.facets).toEqual({
      count: 2,
      contributionCount: 3,
      largest: [
        {id: 'summary.a', contributionCount: 2},
        {id: 'summary.b', contributionCount: 1},
      ],
    })
    expect(summary.capabilities.apiSurface.module).toBe('@/extensions/api')
    expect(summary.capabilities.apiSurface.exportCount).toBeGreaterThan(0)
    expect(summary.capabilities.authoring.guides).toContain('external-sync-plugin')
    expect(summary.capabilities.authoring.moduleCount).toBeGreaterThan(0)
    expect(summary.capabilities.authoring.componentCount).toBeGreaterThan(0)
    expect(summary.more.map(hint => hint.command)).toContain('yarn agent status')
    expect(JSON.stringify(summary)).not.toContain('valueSummary')
  })

  it('surfaces extension-authoring guidance for dialogs, prefs blocks, deterministic ids, and disabled-by-default', async () => {
    const runtime = await resolveFacetRuntime([])

    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [],
      renderers: {},
    }, {
      guides: ['external-sync-plugin'],
      storage: true,
    })

    const syncGuide = description.authoring.guides.find(
      guide => guide.id === 'external-sync-plugin',
    )
    expect(syncGuide).toBeDefined()

    // Disabled-by-default rescue — the highest-friction paper cut from
    // the previous bridge surface. If this assertion fails, the agent
    // is about to spend cycles debugging "Action not found" again.
    expect(syncGuide?.afterInstall?.join(' ')).toMatch(/disabled by default/i)

    // The Dialog pattern must be reachable as code, not just prose,
    // because the only other in-DB example is matrix-chat-client which
    // uses window.prompt — the path of least resistance leads to the
    // wrong pattern without a code snippet to anchor on.
    const exampleCode = syncGuide?.examples?.map(example => example.code).join('\n') ?? ''
    expect(exampleCode).toContain('appMountsFacet')
    expect(exampleCode).toContain('DialogContent')
    // Toast surface + useRepo + openDialog must show up in the worked
    // examples — these are the gotchas a fresh agent would otherwise
    // reach for window.alert / window globals to work around.
    expect(exampleCode).toContain('useRepo')
    expect(exampleCode).toContain('showSuccess')
    expect(exampleCode).toContain('showError')
    expect(exampleCode).toContain('openDialog')
    expect(exampleCode).not.toContain('window.prompt')
    expect(exampleCode).not.toContain('window.alert')
    expect(exampleCode).not.toContain('window.confirm')

    // Storage guide must bless localStorage for credentials and call
    // out deterministic uuids for plugin-owned singletons.
    expect(description.authoring.storage.credentials.rule).toMatch(/localStorage/)
    expect(description.authoring.storage.credentials.example?.code).toMatch(/localStorage/)
    const patternIds = description.authoring.storage.patterns.map(pattern => pattern.id)
    expect(patternIds).toContain('plugin-root-singleton')
    expect(patternIds).toContain('user-prefs-config')

    const rootSingleton = description.authoring.storage.patterns.find(
      pattern => pattern.id === 'plugin-root-singleton',
    )
    expect(rootSingleton?.example?.code).toContain('pluginBlockId')

    const userPrefs = description.authoring.storage.patterns.find(
      pattern => pattern.id === 'user-prefs-config',
    )
    expect(userPrefs?.example?.code).toContain('getPluginPrefsBlock')
    expect(userPrefs?.example?.code).toContain('defineBlockType')
  })

  it('exposes pluginBlockId on the public extension API surface', async () => {
    const surface = await getApiSurface()
    // The api.ts barrel re-exports *concepts*, not libraries. The
    // agent gets a deterministic-id helper that encodes the
    // per-plugin namespace convention — uuid lives behind that helper
    // and isn't re-exported, so plugins don't grow ad-hoc lib deps.
    expect(surface.exports).toContain('pluginBlockId')
    expect(surface.exports).not.toContain('uuidv5')
  })

  it('brief mode drops actions/facets/renderers/modules/components from the response', async () => {
    const facet = defineFacet({id: 'brief.facet'})
    const runtime = await resolveFacetRuntime([
      facet.of({id: 'an-action', description: 'x', context: 'global', handler: () => {}}),
    ])

    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [makeAction('an-action', false)],
      renderers: {default: () => null, custom: () => null},
    }, {
      guides: ['external-sync-plugin'],
      brief: true,
    })

    // Bulk sections empty in brief mode...
    expect(description.actions).toEqual([])
    expect(description.facets).toEqual([])
    expect(description.renderers).toEqual([])
    expect(description.authoring.modules).toEqual([])
    expect(description.authoring.components).toEqual([])

    // ...but the authoring content the agent actually wants is still there.
    expect(description.authoring.guides.map(g => g.id)).toContain('external-sync-plugin')
    expect(description.authoring.storage.patterns.length).toBeGreaterThan(0)
    expect(description.apiSurface.exports.length).toBeGreaterThan(0)

    // Whole brief-mode response should be small — the whole point.
    expect(JSON.stringify(description).length).toBeLessThan(40_000)
  })

  it('exposes the authoring primitives plugins reach for first', async () => {
    const surface = await getApiSurface()
    // Without these, agents either pull from internal modules
    // (@/utils/toast, @/utils/dialogs, @/data/orderKey, @/context/repo)
    // or fall back to window.alert / window globals / ad-hoc ordering.
    // The api.ts barrel is the discovery surface, so these have to
    // appear there for the agent to find them without grepping.
    for (const name of [
      'useRepo',
      'openDialog',
      'showError',
      'showInfo',
      'showSuccess',
      'showProgress',
      'keyAtEnd',
      'keysBetween',
    ]) {
      expect(surface.exports).toContain(name)
    }
  })

  it('produces a payload with activeWorkspaceId, currentUser, safeMode, actions, renderers, facets, apiSurface, authoring', async () => {
    const facet = defineFacet({id: 'desc.full'})
    const runtime = await resolveFacetRuntime([
      facet.of('contribution', {source: 'src-1'}),
    ])

    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [
        makeAction('a1', true),
        makeAction('a2', false),
      ],
      renderers: {default: () => null, custom: () => null},
    })

    expect(description.activeWorkspaceId).toBe('ws-1')
    expect(description.currentUser).toEqual({id: 'u-1', name: 'Test'})
    expect(description.safeMode).toBe(false)

    expect(description.actions).toEqual([
      {
        id: 'a1',
        description: 'Description for a1',
        context: 'global',
        hasDefaultBinding: true,
        runnableFromCli: true,
        expectedDependencies: ['uiStateBlock'],
        cliDependencyKeys: ['uiStateBlockId'],
      },
      {
        id: 'a2',
        description: 'Description for a2',
        context: 'global',
        hasDefaultBinding: false,
        runnableFromCli: true,
        expectedDependencies: ['uiStateBlock'],
        cliDependencyKeys: ['uiStateBlockId'],
      },
    ])

    expect(description.renderers.sort()).toEqual(['custom', 'default'])

    const facetIds = description.facets.map((f) => f.id)
    expect(facetIds).toContain('desc.full')

    expect(description.apiSurface.module).toBe('@/extensions/api')
    expect(description.apiSurface.exports).toContain('defineFacet')
    expect(description.authoring.guides.map(guide => guide.id)).toContain('external-sync-plugin')
    expect(description.authoring.modules).toContainEqual(expect.objectContaining({
      importPath: '@/extensions/api.js',
      source: 'generated-api',
      exports: expect.arrayContaining(['getUserPrefsBlock']),
    }))
    expect(description.authoring.components).toContainEqual(expect.objectContaining({
      name: 'Dialog',
      importPath: '@/components/ui/dialog.js',
      source: 'generated-module-glob',
    }))
  })

  it('filters full diagnostics by action, facet, and generated authoring text', async () => {
    const readwiseFacet = defineFacet({id: 'data.propertySchemas'})
    const otherFacet = defineFacet({id: 'core.actions'})
    const runtime = await resolveFacetRuntime([
      readwiseFacet.of({name: 'readwise:book-id'}),
      otherFacet.of('other'),
    ])

    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [
        makeAction('user.readwise.sync-now', false),
        makeAction('quick_find', false),
      ],
      renderers: {},
    }, {
      actions: ['user.readwise'],
      facets: ['data.propertySchemas'],
      guides: ['external-sync-plugin'],
      modules: ['dialog'],
      components: ['input'],
    })

    expect(description.actions.map(action => action.id)).toEqual(['user.readwise.sync-now'])
    expect(description.facets.map(facet => facet.id)).toEqual(['data.propertySchemas'])
    expect(description.authoring.guides.map(guide => guide.id)).toEqual(['external-sync-plugin'])
    expect(description.authoring.modules.every(module =>
      [module.importPath, module.category, module.description, ...(module.exports ?? [])]
        .join(' ')
        .toLowerCase()
        .includes('dialog'),
    )).toBe(true)
    expect(description.authoring.components.map(component => component.name)).toContain('Input')
    expect(description.authoring.components.every(component =>
      [component.name, component.importPath, component.category, component.description, ...component.exports]
        .join(' ')
        .toLowerCase()
        .includes('input'),
    )).toBe(true)
  })

  it('includes modules discovered from the current document import map and module preload links', async () => {
    const runtime = await resolveFacetRuntime([])
    const doc = document.implementation.createHTMLDocument('agent runtime')
    const base = doc.createElement('base')
    base.href = 'http://example.test/'
    doc.head.append(base)
    const importMap = doc.createElement('script')
    importMap.type = 'importmap'
    importMap.textContent = JSON.stringify({
      imports: {
        '@/': './src/',
        react: 'https://esm.sh/react@19.2.5?dev',
      },
    })
    doc.head.append(importMap)
    const preload = doc.createElement('link')
    preload.rel = 'modulepreload'
    preload.href = '/src/plugins/readwise/index.js'
    doc.head.append(preload)

    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: false,
      actions: [],
      renderers: {},
      document: doc,
    }, {
      modules: ['readwise'],
    })

    expect(description.authoring.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          importPath: '@/plugins/readwise/index.js',
          source: 'html-preload',
        }),
      ]),
    )
  })

  it('reports safeMode=true when set', async () => {
    const runtime = await resolveFacetRuntime([])
    const description = await describeRuntime({
      repo: fakeRepo,
      runtime,
      safeMode: true,
      actions: [],
      renderers: {},
    })
    expect(description.safeMode).toBe(true)
  })
})
