import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setCompileImplForTest,
  createCompileCache,
  type CompileCache,
} from '@/extensions/compileExtensionModule'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions'
import {
  defineFacet,
  resolveFacetRuntime,
  type AppExtension,
} from '@/extensions/facet'
import type { Repo } from '@/data/repo'
import type { BlockData, BlockProperties } from '@/types'

// Mirror the seam used by the rest of the suite: a test-local facet so
// contributions are visible without coupling to the app's blessed
// facets.
const integrationFacet = defineFacet<{label: string}, string[]>({
  id: 'test.integration',
  combine: (values) => values.map((v) => v.label),
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
  deleted: overrides.deleted ?? false,
})

const disabled = (value: boolean): BlockProperties => ({
  'system:disabled': {name: 'system:disabled', type: 'boolean', value},
})

const makeRepo = (blocks: BlockData[]): Repo => ({
  findBlocksByType: async () => blocks,
}) as unknown as Repo

let cache: CompileCache

beforeEach(() => {
  cache = createCompileCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dynamicExtensionsExtension — full integration', () => {
  it('extension contributions show up in a fully-resolved runtime alongside base extensions', async () => {
    const baseExtension: AppExtension = integrationFacet.of(
      {label: 'from-base'},
      {source: 'base-extension'},
    )
    const blocks = [blockData({id: 'ext-1', content: 'src-1'})]
    const restore = __setCompileImplForTest(async () => ({
      default: integrationFacet.of({label: 'from-block'}),
    }))

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime([baseExtension, ext])

      expect(runtime.read(integrationFacet)).toEqual(['from-base', 'from-block'])

      const sources = runtime.contributions(integrationFacet).map((c) => c.source)
      expect(sources).toContain('base-extension')
      expect(sources).toContain('block:ext-1')
    } finally {
      restore()
    }
  })

  it('a broken extension does not break the rest — error reported, others survive', async () => {
    const blocks = [
      blockData({id: 'broken', content: 'src-broken'}),
      blockData({id: 'good', content: 'src-good'}),
    ]
    const restore = __setCompileImplForTest(async (content) => {
      if (content === 'src-broken') throw new Error('compile blew up')
      return {default: integrationFacet.of({label: 'survived'})}
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

      expect(runtime.read(integrationFacet)).toEqual(['survived'])
      expect(errorReporter).toHaveBeenCalledWith('broken', expect.any(Error))
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  })

  it('system:disabled extensions do not appear in the runtime', async () => {
    const blocks = [
      blockData({id: 'enabled', content: 'src-enabled'}),
      blockData({id: 'disabled', content: 'src-disabled', properties: disabled(true)}),
    ]
    const restore = __setCompileImplForTest(async (content) => ({
      default: integrationFacet.of({label: content}),
    }))

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(integrationFacet)).toEqual(['src-enabled'])
    } finally {
      restore()
    }
  })

  it('a block defining its own facet and contributing to it both work', async () => {
    // Models the user-defined-facet workflow: a block does
    //   const myFacet = defineFacet({id: 'user.my'})
    //   export default [myFacet.of(x)]
    // The block exports just contributions; the facet definition lives
    // on the module's local scope, but FacetRuntime keys by id so the
    // contribution still finds an existing facet definition with the
    // same id (whether the block defines it or another block does).
    const userFacet = defineFacet<string, string[]>({
      id: 'user.my-defined-facet',
      combine: (vs) => [...vs],
      empty: () => [],
    })
    const blocks = [blockData({id: 'def-and-use', content: 'src'})]
    const restore = __setCompileImplForTest(async () => ({
      default: [
        userFacet.of('a'),
        userFacet.of('b'),
      ],
    }))

    try {
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        safeMode: false,
      })
      const runtime = await resolveFacetRuntime(ext)

      expect(runtime.read(userFacet)).toEqual(['a', 'b'])
      const sources = runtime.contributions(userFacet).map((c) => c.source)
      expect(sources).toEqual(['block:def-and-use', 'block:def-and-use'])
    } finally {
      restore()
    }
  })
})
