// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedType } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import { typeSeedsFacet } from '@/data/facets'
import {
  getOrCreateKernelPage,
  kernelPageBlockId,
} from '@/data/kernelPage'
import { Repo } from '@/data/repo'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'

const WS = 'ws-kernel-page'
const FOO_PAGE_TYPE = 'panel:foo'
const FOO_PAGE_NS = '6f9b1f4c-2a0a-4f6e-9e1c-1c9f5b0d2e90'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  // Install a runtime that registers the synthetic marker type alongside
  // kernel data so addTypeInTx will accept it.
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [
      typeSeedsFacet.of(seedType({seedKey: 'test/type/panel-foo', revision: 1, id: FOO_PAGE_TYPE, label: 'Foo'}), {source: 'test'}),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

describe('getOrCreateKernelPage', () => {
  it('creates a deterministic page tagged with PAGE_TYPE plus the marker type', async () => {
    const page = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })

    expect(page.id).toBe(kernelPageBlockId(WS, FOO_PAGE_NS))
    expect(page.peek()?.content).toBe('Foo')
    expect(page.peekProperty(aliasesProp)).toEqual(['Foo'])
    expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
  })

  it('restores a soft-deleted kernel page with both type tags reinstated', async () => {
    const page = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })
    await env.repo.tx(async tx => { await tx.delete(page.id) }, {scope: ChangeScope.BlockDefault})

    const restored = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: FOO_PAGE_TYPE,
    })

    expect(restored.peek()?.deleted).toBe(false)
    expect(restored.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
    expect(restored.peekProperty(aliasesProp)).toEqual(['Foo'])
  })
})
