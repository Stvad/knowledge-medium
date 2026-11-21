import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setCompileImplForTest,
  createCompileCache,
  hashExtensionSource,
  type CompileCache,
} from '@/extensions/compileExtensionModule'
import {
  InMemoryCompiledModuleCache,
  type CompiledModuleCache,
} from '@/extensions/compiledModuleCache'
import { dynamicExtensionsExtension } from '@/extensions/dynamicExtensions'
import {
  defineFacet,
  resolveFacetRuntime,
  type AppExtension,
} from '@/facets/facet'
import type { Overrides } from '@/facets/togglable'
import type { Repo } from '../../data/repo'
import type { BlockData } from '@/data/api'

const integrationFacet = defineFacet<{label: string}, string[]>({
  id: 'test.integration',
  combine: (values) => values.map(v => v.label),
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

const makeRepo = (blocks: BlockData[]): Repo => ({
  query: {
    findExtensionBlocks: () => ({load: async () => blocks}),
  },
}) as unknown as Repo

const enableBlocks = (blocks: readonly BlockData[]): Overrides =>
  new Map(blocks.map(block => [block.id, true]))

let cache: CompileCache
let persistent: CompiledModuleCache

beforeEach(() => {
  cache = createCompileCache()
  persistent = new InMemoryCompiledModuleCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Grant device-local approval for each block, pinned to its current
// content (the gate-2 prerequisite for it to run).
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
      await approveBlocks(blocks)
      const ext = dynamicExtensionsExtension({
        repo: makeRepo(blocks),
        workspaceId: 'ws-1',
        cache,
        persistent,
        safeMode: false,
        overrides: enableBlocks(blocks),
      })
      const runtime = await resolveFacetRuntime([baseExtension, ext])

      expect(runtime.read(integrationFacet)).toEqual(['from-base', 'from-block'])
      const sources = runtime.contributions(integrationFacet).map(c => c.source)
      expect(sources).toContain('base-extension')
      expect(sources).toContain('block:ext-1')
    } finally {
      restore()
    }
  })
})
