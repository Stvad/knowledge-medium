// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedType } from '@/data/api'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
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

  it('tags PAGE_TYPE alone when the page has no marker (the Journal shape)', async () => {
    const page = await getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
      markerType: null,
    })

    expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE])
  })

  it('rejects an omitted markerType by name, rather than failing at the tagger', async () => {
    // The cast is the point: TypeScript already requires the field, so this
    // pins the guard for the callers the type does not reach — a dynamic
    // extension is transpiled, not typechecked. Without it, `undefined` flows
    // into `addTypeInTx` and surfaces as "type id undefined is not
    // registered", which sends the author off to add a type seed instead of
    // to the field they left out.
    await expect(getOrCreateKernelPage(env.repo, WS, {
      namespace: FOO_PAGE_NS,
      alias: 'Foo',
    } as unknown as Parameters<typeof getOrCreateKernelPage>[2]))
      .rejects.toThrow(/markerType is required/)
  })

  /** This helper is extension-facing, so the namespace is chosen by code the
   *  app does not control. Both reads that can find an occupant select on id
   *  alone, and what they feed rewrites properties or undeletes rows — so a
   *  foreign occupant must stop the call rather than be adopted. */
  describe('a row at this id belonging to another workspace', () => {
    const OTHER_WS = 'ws-someone-else'
    const foreignRow = async (deleted: boolean): Promise<string> => {
      const id = kernelPageBlockId(WS, FOO_PAGE_NS)
      await env.repo.tx(async tx => {
        await tx.create({
          id, workspaceId: OTHER_WS, parentId: null, orderKey: 'a0',
          content: 'someone else\'s page',
        })
        if (deleted) await tx.delete(id)
      }, {scope: ChangeScope.BlockDefault})
      return id
    }

    it('is refused rather than repaired', async () => {
      const id = await foreignRow(false)

      await expect(getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })).rejects.toThrow(DeterministicIdCrossWorkspaceError)

      // Untouched: no alias claimed, no type tagged, content as it was.
      const row = await env.repo.load(id)
      expect(row?.workspaceId).toBe(OTHER_WS)
      expect(row?.content).toBe('someone else\'s page')
      expect(row?.properties[aliasesProp.name]).toBeUndefined()
    })

    it('is refused rather than resurrected', async () => {
      const id = await foreignRow(true)

      await expect(getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })).rejects.toThrow(DeterministicIdCrossWorkspaceError)

      // Still deleted — a tombstone in another workspace stays one.
      expect(await env.repo.load(id)).toBeNull()
    })
  })
})
