// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
afterEach(() => { vi.restoreAllMocks() })

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

  /**
   * The repair of a LIVE page, one test per leg of `needsRepair`.
   *
   * Neither leg was pinned by anything above: create covers the empty id,
   * restore covers the tombstone, and the cross-workspace tests never get as
   * far as repairing. Delete either leg and the suite stayed green — while a
   * page that lost its marker type is invisible to every `types`-indexed query
   * that looks for it (including this function's own repair check, which reads
   * the same list), and one that lost its alias is unreachable by name.
   *
   * Both fixtures are built damaged rather than created-then-damaged: a repair
   * path that ran on the way in would launder the damage before the assertion.
   */
  describe('repairing a live page in this workspace', () => {
    it('re-tags a marker type the page has lost', async () => {
      const id = kernelPageBlockId(WS, FOO_PAGE_NS)
      const snapshot = env.repo.snapshotTypeRegistries()
      await env.repo.tx(async tx => {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Foo'})
        await tx.setProperty(id, aliasesProp, ['Foo'])
        // PAGE_TYPE only — the marker is what a caller queries for, and its
        // absence is exactly the state no query can report.
        await env.repo.addTypeInTx(tx, id, PAGE_TYPE, {}, snapshot)
      }, {scope: ChangeScope.BlockDefault})

      const page = await getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })

      expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
      expect(page.peekProperty(aliasesProp)).toEqual(['Foo'])
      expect(page.peek()?.content).toBe('Foo')
    })

    it('re-claims an alias the page has lost, keeping any the user added', async () => {
      const id = kernelPageBlockId(WS, FOO_PAGE_NS)
      const snapshot = env.repo.snapshotTypeRegistries()
      await env.repo.tx(async tx => {
        await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Foo'})
        // Both types present, so this isolates the alias leg — and a second
        // name the user chose, to pin that repair MERGES rather than replaces.
        await tx.setProperty(id, aliasesProp, ['My Foo'])
        await env.repo.addTypeInTx(tx, id, PAGE_TYPE, {}, snapshot)
        await env.repo.addTypeInTx(tx, id, FOO_PAGE_TYPE, {}, snapshot)
      }, {scope: ChangeScope.BlockDefault})

      const page = await getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })

      expect(page.peekProperty(aliasesProp)).toEqual(['Foo', 'My Foo'])
    })
  })


  describe('on a read-only workspace', () => {
    const readOnlyRepo = () => {
      const { repo } = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        isReadOnly: true,
        extensions: [
          typeSeedsFacet.of(seedType({seedKey: 'test/type/panel-foo', revision: 1, id: FOO_PAGE_TYPE, label: 'Foo'}), {source: 'test'}),
        ],
      })
      repo.setActiveWorkspaceId(WS)
      return repo
    }

    it('writes NOTHING when the page is absent', async () => {
      // The kernel already refuses the write (`BlockDefault` is
      // `readOnly: 'reject'`, and the commit pipeline throws `ReadOnlyError`).
      // What this pins is that we don't ATTEMPT it — without the guard, a
      // viewer opening a kernel-page surface gets an unhandled rejection out
      // of an action handler. Asserted on the call, not on the absence of a
      // rendered thing, which would pass for a dozen unrelated reasons.
      const repo = readOnlyRepo()
      const tx = vi.spyOn(repo, 'tx')

      const page = await getOrCreateKernelPage(repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })

      expect(tx).not.toHaveBeenCalled()
      expect(page.id).toBe(kernelPageBlockId(WS, FOO_PAGE_NS))
      expect(await repo.load(page.id)).toBeNull()
    })

    it('still RESOLVES a page the owner already created', async () => {
      // The ordinary viewer case: the id is deterministic, so a synced page
      // comes back normally. Skipping the writes must not break reading.
      await getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })

      const repo = readOnlyRepo()
      const page = await getOrCreateKernelPage(repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })
      await page.load()

      expect(page.peek()?.content).toBe('Foo')
      expect(page.peekProperty(typesProp)).toEqual([PAGE_TYPE, FOO_PAGE_TYPE])
    })

    it('still refuses a FOREIGN occupant at this id', async () => {
      // Being unable to write is not the same as being entitled to read. A
      // read-only session is exactly as exposed to a colliding derived id, and
      // returning the handle unchecked would hand the caller another
      // workspace's block under this workspace's identity — the read analogue
      // of the write this function already refuses.
      const id = kernelPageBlockId(WS, FOO_PAGE_NS)
      await env.repo.tx(async tx => {
        await tx.create({
          id, workspaceId: 'other-workspace', parentId: null, orderKey: 'a0',
          content: 'someone else\'s page',
        }, {systemMint: true})
      }, {scope: ChangeScope.BlockDefault})

      const repo = readOnlyRepo()
      await expect(getOrCreateKernelPage(repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })).rejects.toThrow(DeterministicIdCrossWorkspaceError)
    })

    it('still rejects a malformed spec, rather than silently no-op-ing', async () => {
      // The author-facing validation has to fire whichever session runs it.
      const repo = readOnlyRepo()
      await expect(getOrCreateKernelPage(repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo',
      } as unknown as Parameters<typeof getOrCreateKernelPage>[2]))
        .rejects.toThrow(/markerType is required/)
    })
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

    /** The check runs at three points and the two tests above pin it only
     *  COLLECTIVELY — each enters through the first one, so deleting any single
     *  site leaves them green while another catches the case. The two below
     *  isolate the sites that a plain foreign occupant never reaches. */
    it('is refused even when it is shaped exactly like ours, so nothing needs repair', async () => {
      const id = kernelPageBlockId(WS, FOO_PAGE_NS)
      const snapshot = env.repo.snapshotTypeRegistries()
      await env.repo.tx(async tx => {
        await tx.create({
          id, workspaceId: OTHER_WS, parentId: null, orderKey: 'a0', content: 'Foo',
        })
        await tx.setProperty(id, aliasesProp, ['Foo'])
        await env.repo.addTypeInTx(tx, id, PAGE_TYPE, {}, snapshot)
        await env.repo.addTypeInTx(tx, id, FOO_PAGE_TYPE, {}, snapshot)
      }, {scope: ChangeScope.BlockDefault})

      // A fully-shaped row makes `needsRepair` false, so the repair
      // transaction — and the recheck inside it — is never reached. The
      // pre-repair check is the only thing standing between this call and
      // handing back another workspace's page as ours.
      await expect(getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })).rejects.toThrow(DeterministicIdCrossWorkspaceError)
    })

    it('is refused when it only becomes foreign between the read and the transaction', async () => {
      const id = await foreignRow(false)
      // Sync materialization rewrites every stored column except `id`,
      // `workspace_id` included, so the row read before the transaction can
      // belong to someone else by the time it opens. Simulated by making that
      // read disagree with what is actually on disk.
      const asIfOurs = {...(await env.repo.load(id))!, workspaceId: WS}
      vi.spyOn(env.repo, 'load').mockResolvedValueOnce(asIfOurs)

      await expect(getOrCreateKernelPage(env.repo, WS, {
        namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE,
      })).rejects.toThrow(DeterministicIdCrossWorkspaceError)

      // The repair never ran: no alias claimed, no type tagged.
      const row = await env.repo.load(id)
      expect(row?.properties[aliasesProp.name]).toBeUndefined()
    })
  })
})
