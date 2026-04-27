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
import type { Repo } from '@/data/repo'
import type { BlockData, BlockProperties } from '@/types'

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
  content: overrides.content ?? '',
  properties: overrides.properties ?? {},
  childIds: overrides.childIds ?? [],
  parentId: overrides.parentId,
  createTime: overrides.createTime ?? 0,
  updateTime: overrides.updateTime ?? 0,
  createdByUserId: overrides.createdByUserId ?? 'user-1',
  updatedByUserId: overrides.updatedByUserId ?? 'user-1',
  references: overrides.references ?? [],
})

const disabledProperty = (value: boolean): BlockProperties => ({
  'system:disabled': {name: 'system:disabled', type: 'boolean', value},
})

// Stub repo that just returns the supplied blocks for findBlocksByType.
const makeRepo = (blocks: BlockData[]): Repo => ({
  findBlocksByType: async () => blocks,
}) as unknown as Repo

// Stub compile that returns a canned module for each blockId.
const stubCompileByBlockId = (
  modulesByBlockId: Record<string, ExtensionModule>,
): (() => void) => {
  // compileExtensionModule keys by content hash of the BLOCK content,
  // but when we have `__setCompileImplForTest` we control what each
  // call returns. Map by content so stubs are stable across calls.
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
        default: [
          labelsFacet.of('a'),
          labelsFacet.of('b'),
        ],
      },
    })

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['a', 'b'])
      const contributions = runtime.contributions(labelsFacet)
      expect(contributions.map((c) => c.source)).toEqual(['block:ext-2', 'block:ext-2'])
    } finally {
      restore()
    }
  })

  it('awaits async resolver functions and merges their contributions', async () => {
    const blocks = [blockData({id: 'ext-3', content: 'src-3'})]
    const restore = stubCompileByBlockId({
      'src-3': {
        default: async () => [
          labelsFacet.of('async-a'),
          labelsFacet.of('async-b'),
        ],
      },
    })

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['async-a', 'async-b'])
      expect(runtime.contributions(labelsFacet).map((c) => c.source))
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
      })
      const runtime = await resolveFacetRuntime(ext)

      const contributions = runtime.contributions(labelsFacet)
      const sources = contributions.map((c) => c.source)
      expect(sources).toContain('block:ext-prov/my-plugin')
      expect(sources).toContain('block:ext-prov')
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — system:disabled', () => {
  it('skips blocks with system:disabled = true', async () => {
    const blocks = [
      blockData({id: 'enabled', content: 'src-enabled'}),
      blockData({
        id: 'disabled',
        content: 'src-disabled',
        properties: disabledProperty(true),
      }),
    ]
    const restore = stubCompileByBlockId({
      'src-enabled': {default: labelsFacet.of('on')},
      'src-disabled': {default: labelsFacet.of('off')},
    })

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['on'])
    } finally {
      restore()
    }
  })

  it('loads blocks with system:disabled = false (the default)', async () => {
    const blocks = [
      blockData({
        id: 'explicit-enabled',
        content: 'src',
        properties: disabledProperty(false),
      }),
    ]
    const restore = stubCompileByBlockId({
      src: {default: labelsFacet.of('on')},
    })

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(labelsFacet)).toEqual(['on'])
    } finally {
      restore()
    }
  })
})

describe('dynamicExtensionsExtension — safeMode', () => {
  it('returns empty without querying the repo', async () => {
    const findBlocksByType = vi.fn(async () => [])
    const repo = {findBlocksByType} as unknown as Repo

    const ext = dynamicExtensionsExtension({
      repo,
      workspaceId: 'ws-1',
        cache,
      safeMode: true,
    })
    const runtime = await resolveFacetRuntime(ext)

    expect(runtime.read(labelsFacet)).toEqual([])
    expect(findBlocksByType).not.toHaveBeenCalled()
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
  it('passes the workspaceId through to repo.findBlocksByType', async () => {
    const findBlocksByType = vi.fn(async () => [])
    const repo = {findBlocksByType} as unknown as Repo

    const ext = dynamicExtensionsExtension({
      repo,
      workspaceId: 'ws-target',
      cache,
      safeMode: false,
    })
    await resolveFacetRuntime(ext)

    expect(findBlocksByType).toHaveBeenCalledWith('ws-target', 'extension')
  })
})

// Type-level guard: confirm the public function signature is what we
// expect (callers will likely pass the AppExtension into
// resolveFacetRuntime alongside other extensions).
type _TypeCheck = AppExtension extends ReturnType<typeof dynamicExtensionsExtension>
  ? true
  : never
const _typeCheck: _TypeCheck = true
void _typeCheck
