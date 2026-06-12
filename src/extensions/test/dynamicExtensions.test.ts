import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions'
import {
  __setCompileImplForTest,
  createCompileCache,
  type CompileCache,
  type ExtensionModule,
} from '@/extensions/compileExtensionModule'
import {
  defineFacet,
  resolveFacetRuntime,
  type AppExtension,
  type FacetContribution,
} from '@/extensions/facet'
import { getBoundary } from '@/extensions/togglable'
import type { Overrides } from '@/extensions/togglable'
import type { Repo } from '../../data/repo'
import type { BlockData } from '@/data/api'

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
// findExtensionBlocks query (Phase 4 chunk C migrated from
// findBlocksByType). The query proxy is stubbed to return a handle
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

// Stub compile that returns a canned module per block content.
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

beforeEach(() => {
  cache = createCompileCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dynamicExtensionsExtension — happy paths', () => {
  it('loads a block exporting a single FacetContribution', async () => {
    const blocks = [blockData({id: 'ext-1', content: 'src-1'})]
    const restore = stubCompileByBlockId({
      'src-1': {default: labelsFacet.of('hello')},
    })

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
      // resolveAppRuntime (not resolveFacetRuntime) is what production
      // uses — it's the one that recurses into `enables`.
      const {resolveAppRuntime} = await import('@/extensions/resolveAppRuntime.js')
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

describe('dynamicExtensionsExtension — overrides-driven disable', () => {
  it('leaves new user extension blocks disabled until an explicit true override exists', async () => {
    const compileImpl = vi.fn().mockImplementation(async () => ({
      default: labelsFacet.of('should-not-compile'),
    }))
    const restore = __setCompileImplForTest(compileImpl)
    const blocks = [blockData({id: 'new-block', content: 'src-new'})]

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
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
    const blocks = [
      blockData({id: 'enabled-block', content: 'src-enabled'}),
      blockData({id: 'disabled-block', content: 'src-disabled'}),
    ]
    const overrides: Overrides = new Map([
      ['enabled-block', true],
      ['disabled-block', false],
    ])

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['compiled:src-enabled'])
      // Crucially the disabled block's content is never run through
      // the compiler — that's what makes the toggle safe for blocks
      // whose top-level code has side effects.
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
    const blocks = [
      blockData({id: 'visible-disabled', content: 'src-disabled', properties: {}}),
      blockData({id: 'visible-on', content: 'src-on'}),
    ]
    const overrides: Overrides = new Map([
      ['visible-disabled', false],
      ['visible-on', true],
    ])

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides,
      })
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
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
      const ext = dynamicExtensionsExtension({
        repo,
        workspaceId: 'ws-1',
        cache,
        safeMode: true,
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
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
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
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

    const ext = dynamicExtensionsExtension({
      repo,
      workspaceId: 'ws-target',
      cache,
      safeMode: false,
    })
    await resolveFacetRuntime(ext)

    expect(findExtensionBlocks).toHaveBeenCalledWith({workspaceId: 'ws-target'})
  })
})
