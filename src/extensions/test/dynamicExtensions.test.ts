import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dynamicExtensionsExtension,
  type DynamicExtensionsOptions,
} from '@/extensions/dynamicExtensions'
import {
  __setCompileImplForTest,
  createCompileCache,
  hashExtensionSource,
  type CompileCache,
  type ExtensionModule,
} from '@/extensions/compileExtensionModule'
import {
  InMemoryCompiledModuleCache,
  type CompiledModuleCache,
} from '@/extensions/compiledModuleCache'
import {
  defineFacet,
  resolveFacetRuntime,
  type AppExtension,
  type FacetContribution,
} from '@/facets/facet'
import { getBoundary } from '@/facets/togglable'
import type { Overrides } from '@/facets/togglable'
import type { Repo } from '../../data/repo'
import type { BlockData } from '@/data/api'
import {ChangeScope, definePropertyEditorOverride} from '@/data/api'
import {definitionSeedsFacet, propertyEditorOverridesFacet} from '@/data/facets'
import {seedProperty} from '@/data/propertySeeds'
import {extensionPropertySeedKey} from '@/extensions/dynamicExtensionSeeds'

// Test-local facet so contributions don't pollute / collide with the
// real app facets.
const labelsFacet = defineFacet<string, string[]>({
  id: 'test.dynamic-labels',
  combine: (values) => [...values],
  empty: () => [],
})

const blockData = (overrides: Partial<BlockData>): BlockData => ({
  id: overrides.id ?? 'block',
  workspaceId: overrides.workspaceId ?? 'ws-1',
  parentId: overrides.parentId ?? null,
  orderKey: overrides.orderKey ?? 'a0',
  content: overrides.content ?? '',
  properties: overrides.properties ?? {},
  references: overrides.references ?? [],
  createdAt: overrides.createdAt ?? 0,
  updatedAt: overrides.updatedAt ?? 0,
  userUpdatedAt: overrides.userUpdatedAt ?? 0,
  createdBy: overrides.createdBy ?? 'user-1',
  updatedBy: overrides.updatedBy ?? 'user-1',
  deleted: overrides.deleted ?? false,
})

// Stub repo that just returns the supplied blocks for the
// findExtensionBlocks query. The query proxy is stubbed to return a handle
// whose `.load()` resolves to the canned block list.
const makeRepo = (blocks: BlockData[]): Repo => ({
  query: {
    findExtensionBlocks: () => ({
      load: async () => blocks,
    }),
  },
}) as unknown as Repo

const enableBlocks = (blocks: readonly BlockData[]): Overrides =>
  new Map(blocks.map(block => [block.id, true]))

// Stub compile that returns a canned module per block content. With a
// compile override active the loader's approved-load path runs
// `override(approval.approvedSource)`, so the keys here are matched
// against the APPROVED source (which `approveBlocks` pins to live content).
const stubCompileByBlockId = (
  modulesByBlockId: Record<string, ExtensionModule>,
): (() => void) => {
  return __setCompileImplForTest(async (content) => {
    const module = modulesByBlockId[content]
    if (!module) throw new Error(`No stub for content: ${content}`)
    return module
  })
}

let cache: CompileCache
let persistent: CompiledModuleCache

beforeEach(() => {
  cache = createCompileCache()
  persistent = new InMemoryCompiledModuleCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Construct the loader with the per-test in-memory caches injected, so it
// never reaches for the IndexedDB-backed singletons.
const loadExtensions = (
  blocks: BlockData[],
  opts: Partial<Omit<DynamicExtensionsOptions, 'repo' | 'workspaceId'>> & {
    repo?: Repo
    workspaceId?: string
  } = {},
): AppExtension => {
  const {repo, workspaceId, ...rest} = opts
  return dynamicExtensionsExtension({
    repo: repo ?? makeRepo(blocks),
    workspaceId: workspaceId ?? 'ws-1',
    cache,
    persistent,
    safeMode: false,
    ...rest,
  })
}

// Grant the device-local approval for each block, pinned to its CURRENT
// content (so there's no drift). This is the gate-2 prerequisite for a
// block to actually run.
const approveBlocks = async (blocks: readonly BlockData[]): Promise<void> => {
  for (const block of blocks) {
    await persistent.write(block.id, {
      sourceHash: await hashExtensionSource(block.content),
      approvedSource: block.content,
      compiled: block.content,
      compilerVersion: '1',
      approvedAt: 0,
    })
  }
}

describe('dynamicExtensionsExtension — happy paths', () => {
  it('loads a block exporting a single FacetContribution', async () => {
    const blocks = [blockData({id: 'ext-1', content: 'src-1'})]
    const restore = stubCompileByBlockId({
      'src-1': {default: labelsFacet.of('hello')},
    })

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {overrides: enableBlocks(blocks)})
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['hello'])
      const contributions = runtime.contributions(labelsFacet)
      expect(contributions[0]?.source).toBe('block:ext-1')
    } finally {
      restore()
    }
  })

  it('loads a block exporting an array of FacetContributions', async () => {
    const blocks = [blockData({id: 'ext-2', content: 'src-2'})]
    const restore = stubCompileByBlockId({
      'src-2': {
        default: [labelsFacet.of('a'), labelsFacet.of('b')],
      },
    })

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {overrides: enableBlocks(blocks)})
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['a', 'b'])
      expect(runtime.contributions(labelsFacet).map(c => c.source))
        .toEqual(['block:ext-2', 'block:ext-2'])
    } finally {
      restore()
    }
  })

  it('awaits async resolver functions and merges their contributions', async () => {
    const blocks = [blockData({id: 'ext-3', content: 'src-3'})]
    const restore = stubCompileByBlockId({
      'src-3': {
        default: async () => [labelsFacet.of('async-a'), labelsFacet.of('async-b')],
      },
    })

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {overrides: enableBlocks(blocks)})
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['async-a', 'async-b'])
      expect(runtime.contributions(labelsFacet).map(c => c.source))
        .toEqual(['block:ext-3', 'block:ext-3'])
    } finally {
      restore()
    }
  })

  it('treats null / undefined / false default exports as empty (no error)', async () => {
    const blocks = [
      blockData({id: 'ext-null', content: 'src-null'}),
      blockData({id: 'ext-undef', content: 'src-undef'}),
      blockData({id: 'ext-false', content: 'src-false'}),
    ]
    const restore = stubCompileByBlockId({
      'src-null': {default: null},
      'src-undef': {default: undefined},
      'src-false': {default: false},
    })
    const errorReporter = vi.fn()

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        errorReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual([])
      expect(errorReporter).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — provenance', () => {
  it('composes block:<id>/<author-source> when the author supplies a source', async () => {
    const blocks = [blockData({id: 'ext-prov', content: 'src-prov'})]
    const restore = stubCompileByBlockId({
      'src-prov': {
        default: [
          labelsFacet.of('with-source', {source: 'my-plugin'}),
          labelsFacet.of('no-source'),
        ],
      },
    })

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {overrides: enableBlocks(blocks)})
      const runtime = await resolveFacetRuntime(ext)

      const sources = runtime.contributions(labelsFacet).map(c => c.source)
      expect(sources).toContain('block:ext-prov/my-plugin')
      expect(sources).toContain('block:ext-prov')
    } finally {
      restore()
    }
  })

  it('walks FacetContribution.enables so nested contributions get the block:<id> prefix too', async () => {
    // Authors can attach a "dragged-along" subtree via `enables`.
    // Without recursion the spread in prefixContributionSource leaves
    // those nested contributions with their original source string
    // (or none), so describeRuntime / agent attribution would
    // mis-credit them. The loader must walk into `enables` exactly
    // like it walks the rest of the AppExtension tree.
    const blocks = [blockData({id: 'ext-enables', content: 'src-enables'})]
    const restore = stubCompileByBlockId({
      'src-enables': {
        default: labelsFacet.of('outer', {
          enables: [
            labelsFacet.of('inner-no-source'),
            labelsFacet.of('inner-with-source', {source: 'helper'}),
          ],
        }),
      },
    })

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {overrides: enableBlocks(blocks)})
      // resolveAppRuntime (not resolveFacetRuntime) is what production
      // uses — it's the one that recurses into `enables`.
      const {resolveAppRuntime} = await import('@/facets/resolveAppRuntime.js')
      const runtime = await resolveAppRuntime([ext], {overrides: enableBlocks(blocks)})

      const sources = runtime.contributions(labelsFacet).map(c => c.source)
      expect(sources).toContain('block:ext-enables')
      expect(sources).toContain('block:ext-enables/helper')
      // The unsourced enables sibling should pick up the bare prefix
      // (same composition rule as the outer contribution).
      const innerNoSource = sources.filter(s => s === 'block:ext-enables')
      expect(innerNoSource.length).toBe(2)
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — property seed identity', () => {
  it('binds reserved seed owners per block and does not share identical-source modules', async () => {
    const blocks = [
      blockData({id: 'ext/one', content: 'same-source'}),
      blockData({id: 'ext-two', content: 'same-source'}),
    ]
    const declarations: ReturnType<typeof seedProperty>[] = []
    const restore = __setCompileImplForTest(async () => {
      const declaration = seedProperty({
        seedKey: extensionPropertySeedKey('status'),
        revision: 1,
        name: 'example:status',
        preset: 'boolean',
        defaultValue: false,
        changeScope: ChangeScope.BlockDefault,
      })
      declarations.push(declaration)
      return {default: definitionSeedsFacet.of(declaration)}
    })

    try {
      await approveBlocks(blocks)
      const runtime = await resolveFacetRuntime(loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
      }))

      expect(declarations).toHaveLength(2)
      expect(declarations[0]).not.toBe(declarations[1])
      const runtimeSeeds = runtime.read(definitionSeedsFacet)
      expect(runtimeSeeds[0]).toBe(declarations[0])
      expect(runtimeSeeds[1]).toBe(declarations[1])
      expect(declarations.map(seed => seed.seedKey)).toEqual([
        'ext%2Fone/property/status',
        'ext-two/property/status',
      ])
    } finally {
      restore()
    }
  })

  it('binds a dynamic editor override to the block so its seedKey matches its seed', async () => {
    // The override must join its seed by the SAME block-scoped seedKey the seed
    // received, or the seed-identity join silently misses (B′ §8).
    const blocks = [blockData({id: 'ext-ovr', content: 'with-override'})]
    const restore = __setCompileImplForTest(async () => {
      const declaration = seedProperty({
        seedKey: extensionPropertySeedKey('status'),
        revision: 1,
        name: 'example:status',
        preset: 'boolean',
        defaultValue: false,
        changeScope: ChangeScope.BlockDefault,
      })
      const override = definePropertyEditorOverride(declaration, {label: 'Status'})
      return {default: [
        definitionSeedsFacet.of(declaration),
        propertyEditorOverridesFacet.of(override),
      ]}
    })

    try {
      await approveBlocks(blocks)
      const runtime = await resolveFacetRuntime(loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
      }))

      const seeds = runtime.read(definitionSeedsFacet)
      const overrides = runtime.read(propertyEditorOverridesFacet)
      expect(seeds[0]?.seedKey).toBe('ext-ovr/property/status')
      // Bound to the same block-scoped key, so it keys the override map there.
      expect(overrides.get('ext-ovr/property/status')?.label).toBe('Status')
      expect(overrides.has(extensionPropertySeedKey('status'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('rejects hard-coded owners so dynamic seeds cannot collide across installs', async () => {
    const blocks = [blockData({id: 'ext-hardcoded', content: 'hardcoded'})]
    const declaration = seedProperty({
      seedKey: 'example/property/status',
      revision: 1,
      name: 'example:status',
      preset: 'boolean',
      defaultValue: false,
      changeScope: ChangeScope.BlockDefault,
    })
    const restore = stubCompileByBlockId({
      hardcoded: {default: definitionSeedsFacet.of(declaration)},
    })
    const errorReporter = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await approveBlocks(blocks)
      const runtime = await resolveFacetRuntime(loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        errorReporter,
      }))

      expect(runtime.read(definitionSeedsFacet)).toEqual([])
      expect(errorReporter).toHaveBeenCalledWith(
        'ext-hardcoded',
        expect.objectContaining({
          message: 'Dynamic property seeds must use extensionPropertySeedKey(key)',
        }),
      )
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  })

  it('rejects a seed declaration mis-contributed to the override facet', async () => {
    // A seed handle structurally satisfies PropertyEditorOverride (both carry a
    // string seedKey), so a misrouted `propertyEditorOverridesFacet.of(seed)`
    // type-checks; the runtime guard must reject it (it carries revision/presetId)
    // and fail the block loudly rather than pollute the override registry.
    const blocks = [blockData({id: 'ext-misroute', content: 'misroute'})]
    const seed = seedProperty({
      seedKey: extensionPropertySeedKey('status'),
      revision: 1,
      name: 'example:status',
      preset: 'boolean',
      defaultValue: false,
      changeScope: ChangeScope.BlockDefault,
    })
    const restore = stubCompileByBlockId({
      misroute: {default: propertyEditorOverridesFacet.of(seed)},
    })
    const errorReporter = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await approveBlocks(blocks)
      const runtime = await resolveFacetRuntime(loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        errorReporter,
      }))

      expect(runtime.read(propertyEditorOverridesFacet).size).toBe(0)
      expect(errorReporter).toHaveBeenCalledWith(
        'ext-misroute',
        expect.objectContaining({
          message: 'Dynamic property editor override contribution is malformed',
        }),
      )
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  })
})

describe('dynamicExtensionsExtension — gate 1 (intent / overrides)', () => {
  it('leaves new user extension blocks disabled until an explicit true override exists', async () => {
    const compileImpl = vi.fn().mockImplementation(async () => ({
      default: labelsFacet.of('should-not-compile'),
    }))
    const restore = __setCompileImplForTest(compileImpl)
    const blocks = [blockData({id: 'new-block', content: 'src-new'})]

    try {
      // Approval present, but intent absent → gate 1 still skips it.
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks)
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual([])
      expect(compileImpl).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('does not compile or contribute blocks that are disabled in overrides', async () => {
    const compileImpl = vi.fn().mockImplementation(async (content: string) => ({
      default: labelsFacet.of(`compiled:${content}`),
    }))
    const restore = __setCompileImplForTest(compileImpl)
    const enabled = blockData({id: 'enabled-block', content: 'src-enabled'})
    const disabled = blockData({id: 'disabled-block', content: 'src-disabled'})
    const blocks = [enabled, disabled]
    const overrides: Overrides = new Map([
      ['enabled-block', true],
      ['disabled-block', false],
    ])

    try {
      // Only the enabled block is approved; the disabled one is skipped by
      // gate 1 before its approval/source is ever touched.
      await approveBlocks([enabled])
      const ext = loadExtensions(blocks, {overrides})
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['compiled:src-enabled'])
      // Crucially the disabled block's content is never run through the
      // compiler — that's what makes the toggle safe for blocks whose
      // top-level code has side effects.
      const compiledContents = compileImpl.mock.calls.map(c => c[0])
      expect(compiledContents).toEqual(['src-enabled'])
    } finally {
      restore()
    }
  })

  it('emits a shell boundary for each disabled block so settings can still surface them', async () => {
    const restore = stubCompileByBlockId({
      'src-on': {default: labelsFacet.of('on')},
    })
    const onBlock = blockData({id: 'visible-on', content: 'src-on'})
    const blocks = [
      blockData({id: 'visible-disabled', content: 'src-disabled', properties: {}}),
      onBlock,
    ]
    const overrides: Overrides = new Map([
      ['visible-disabled', false],
      ['visible-on', true],
    ])

    try {
      await approveBlocks([onBlock])
      const ext = loadExtensions(blocks, {overrides})
      // Resolve the function to walk its return value.
      const factory = ext as (ctx: Record<string, unknown>) => Promise<AppExtension[]>
      const subtree = await factory({})

      expect(subtree.length).toBe(2)
      const handles = subtree
        .map(node => getBoundary(node))
        .filter((h): h is NonNullable<typeof h> => h !== undefined)
      const ids = handles.map(h => h.id).sort()
      expect(ids).toEqual(['visible-disabled', 'visible-on'])
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — gate 2 (device-local trust / #67)', () => {
  it('does NOT run an enabled-by-intent block that is not approved here, and reports needs-approval', async () => {
    const compileImpl = vi.fn().mockImplementation(async () => ({
      default: labelsFacet.of('should-not-run'),
    }))
    const restore = __setCompileImplForTest(compileImpl)
    const blocks = [blockData({id: 'unapproved', content: 'src-x'})]
    const approvalStatusReporter = vi.fn()

    try {
      // Intent true, but NO approval seeded.
      const ext = loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        approvalStatusReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual([])
      expect(compileImpl).not.toHaveBeenCalled()
      expect(approvalStatusReporter).toHaveBeenCalledTimes(1)
      const [blockId, status] = approvalStatusReporter.mock.calls[0]
      expect(blockId).toBe('unapproved')
      expect(status).toMatchObject({kind: 'needs-approval'})
      expect((status as {liveHash: string}).liveHash).toBe(
        await hashExtensionSource('src-x'),
      )
    } finally {
      restore()
    }
  })

  it('does NOT treat a legacy Phase-1 compile-cache row as approval (#67 upgrade path)', async () => {
    const compileImpl = vi.fn().mockImplementation(async () => ({
      default: labelsFacet.of('should-not-run'),
    }))
    const restore = __setCompileImplForTest(compileImpl)
    const block = blockData({id: 'legacy', content: 'src-legacy'})
    const approvalStatusReporter = vi.fn()

    try {
      // A row left over from Phase 1's implicit auto-approve: no
      // approvedSource / approvedAt. Must NOT count as a trust grant.
      await persistent.write('legacy', {
        sourceHash: await hashExtensionSource('src-legacy'),
        compiled: 'src-legacy',
        compilerVersion: '1',
      } as never)
      const ext = loadExtensions([block], {
        overrides: enableBlocks([block]),
        approvalStatusReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual([])
      expect(compileImpl).not.toHaveBeenCalled()
      expect(approvalStatusReporter).toHaveBeenCalledWith(
        'legacy',
        expect.objectContaining({kind: 'needs-approval'}),
      )
    } finally {
      restore()
    }
  })

  it('keeps running the PINNED approved version when live source drifted, and reports update-available', async () => {
    // override resolves both versions so we can detect which one ran.
    const restore = __setCompileImplForTest(async (content) => {
      if (content === 'src-old') return {default: labelsFacet.of('old')}
      if (content === 'src-new') return {default: labelsFacet.of('new')}
      throw new Error(`unexpected content: ${content}`)
    })
    const block = blockData({id: 'drifted', content: 'src-new'})
    const approvalStatusReporter = vi.fn()

    try {
      // Approval pinned to the OLD source; live content is now src-new.
      await persistent.write('drifted', {
        sourceHash: await hashExtensionSource('src-old'),
        approvedSource: 'src-old',
        compiled: 'src-old',
        compilerVersion: '1',
        approvedAt: 0,
      })
      const ext = loadExtensions([block], {
        overrides: enableBlocks([block]),
        approvalStatusReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      // The PINNED (old) version runs — never the drifted live content.
      expect(runtime.read(labelsFacet)).toEqual(['old'])
      expect(approvalStatusReporter).toHaveBeenCalledTimes(1)
      const [blockId, status] = approvalStatusReporter.mock.calls[0]
      expect(blockId).toBe('drifted')
      expect(status).toMatchObject({
        kind: 'update-available',
        liveHash: await hashExtensionSource('src-new'),
        approvedHash: await hashExtensionSource('src-old'),
      })
    } finally {
      restore()
    }
  })

  it('verifyLiveSource compiles the live source directly, bypassing the approval gate', async () => {
    const restore = stubCompileByBlockId({
      'src-verify': {default: labelsFacet.of('verified')},
    })
    const blocks = [blockData({id: 'to-verify', content: 'src-verify'})]
    const approvalStatusReporter = vi.fn()

    try {
      // No approval seeded — verify mode runs live source anyway.
      const ext = loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        verifyLiveSource: true,
        approvalStatusReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['verified'])
      // Verify mode never consults the approval gate, so no status report.
      expect(approvalStatusReporter).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — boundary tagging', () => {
  it('wraps each enabled block with a userExtensionToggle boundary whose id is the block id', async () => {
    const restore = stubCompileByBlockId({
      'src-a': {default: labelsFacet.of('a')},
      'src-b': {default: labelsFacet.of('b')},
    })
    const blocks = [
      blockData({id: 'block-a', content: 'src-a'}),
      blockData({id: 'block-b', content: 'src-b'}),
    ]

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {overrides: enableBlocks(blocks)})
      const factory = ext as (ctx: Record<string, unknown>) => Promise<AppExtension[]>
      const subtree = await factory({})

      const ids = subtree
        .map(node => getBoundary(node)?.id)
        .filter((id): id is string => id !== undefined)
      expect(ids.sort()).toEqual(['block-a', 'block-b'])
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — safeMode', () => {
  it('enumerates blocks but emits shells (never compiles) so the settings tree can still surface them', async () => {
    // Why the query MUST run: the user typically lands in `?safeMode`
    // exactly to recover from a broken extension. Returning [] here
    // would hide every extension row from the Extensions settings
    // tree, leaving them unreachable for toggling. Emitting shells
    // means the toggle rows appear without running any extension's
    // top-level module code.
    const compileImpl = vi.fn().mockImplementation(async () => ({
      default: labelsFacet.of('should-not-run'),
    }))
    const restore = __setCompileImplForTest(compileImpl)
    const blocks = [
      blockData({id: 'block-a', content: 'src-a'}),
      blockData({id: 'block-b', content: 'src-b'}),
    ]
    const findExtensionBlocks = vi.fn(() => ({load: async () => blocks}))
    const repo = {query: {findExtensionBlocks}} as unknown as Repo

    try {
      // Even with approvals + intent, safe mode short-circuits to shells.
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {
        repo,
        safeMode: true,
        overrides: enableBlocks(blocks),
      })
      const factory = ext as (
        ctx: Record<string, unknown>,
      ) => Promise<AppExtension[]>
      const subtree = await factory({})

      expect(findExtensionBlocks).toHaveBeenCalledTimes(1)
      expect(compileImpl).not.toHaveBeenCalled()

      // Shells carry the boundary handle so discoverToggleTree can
      // surface them, but the wrapped extension is empty so no
      // contributions land in the runtime.
      const ids = subtree
        .map(node => getBoundary(node)?.id)
        .filter((id): id is string => id !== undefined)
        .sort()
      expect(ids).toEqual(['block-a', 'block-b'])

      const runtime = await resolveFacetRuntime(ext)
      expect(runtime.read(labelsFacet)).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — failure isolation', () => {
  it('reports compile failures via errorReporter and continues with other blocks', async () => {
    const blocks = [
      blockData({id: 'broken', content: 'src-broken'}),
      blockData({id: 'good', content: 'src-good'}),
    ]
    const restore = __setCompileImplForTest(async (content) => {
      if (content === 'src-broken') throw new Error('compile failed')
      return {default: labelsFacet.of('survived')}
    })
    const errorReporter = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        errorReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['survived'])
      expect(errorReporter).toHaveBeenCalledTimes(1)
      const [reportedBlockId, reportedError] = errorReporter.mock.calls[0]
      expect(reportedBlockId).toBe('broken')
      expect((reportedError as Error).message).toBe('compile failed')
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  })

  it('reports invalid default-export shapes via errorReporter', async () => {
    const blocks = [blockData({id: 'bad-shape', content: 'src-bad'})]
    const restore = stubCompileByBlockId({
      'src-bad': {default: 'this is a string, not an extension' as unknown as FacetContribution<unknown>},
    })
    const errorReporter = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await approveBlocks(blocks)
      const ext = loadExtensions(blocks, {
        overrides: enableBlocks(blocks),
        errorReporter,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual([])
      expect(errorReporter).toHaveBeenCalledTimes(1)
      const [reportedBlockId, reportedError] = errorReporter.mock.calls[0]
      expect(reportedBlockId).toBe('bad-shape')
      expect((reportedError as Error).message).toMatch(/invalid shape/)
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  })
})

describe('dynamicExtensionsExtension — workspace scoping', () => {
  it('passes the workspaceId through to repo.query.findExtensionBlocks', async () => {
    const findExtensionBlocks = vi.fn(() => ({load: async () => []}))
    const repo = {query: {findExtensionBlocks}} as unknown as Repo

    const ext = loadExtensions([], {repo, workspaceId: 'ws-target'})
    await resolveFacetRuntime(ext)

    expect(findExtensionBlocks).toHaveBeenCalledWith({workspaceId: 'ws-target'})
  })
})
