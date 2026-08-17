// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
import { mergeBlocksInTx } from '@/data/blockMerge'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { addBlockTypeToProperties, getBlockTypes, typesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

const WS = 'ws-merge-types'

const TYPE_A = '1111aaaa-1111-4111-8111-111111111111'
const TYPE_B = '2222bbbb-2222-4222-8222-222222222222'
const MEMBER = '3333cccc-3333-4333-8333-333333333333'
const OTHER = '4444dddd-4444-4444-8444-444444444444'

interface Harness {
  h: TestDb
  repo: Repo
  read(id: string): BlockData | undefined
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo, cache } = createTestRepo({db: h.db, user: {id: 'user-1'}})
  return {h, repo, read: id => cache.getSnapshot(id)}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

/** `types` cell built through the blessed raw membership writer — the same
 *  encoding `TypeTagger` and the typeify processor produce. Written directly at
 *  create time rather than through `repo.addType`, which would additionally
 *  require the type to be published in `repo.types` (a facet-bridge round trip
 *  this processor is indifferent to). */
const typesProperty = (...typeIds: readonly string[]): Record<string, unknown> =>
  typeIds.reduce<Record<string, unknown>>(
    (props, typeId) => addBlockTypeToProperties(props, typeId), {})

/** A minimal user-defined type-definition row. The kernel typeify processor
 *  completes it from here (label from content, PAGE_TYPE, label alias). */
const createTypeDefinition = async (
  repo: Repo, id: string, label: string, orderKey: string,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId: 'p', orderKey,
      content: label,
      properties: typesProperty(BLOCK_TYPE_TYPE),
    })
  }, {scope: ChangeScope.BlockDefault})
}

/** A plain block tagged with `typeIds`, settled. */
const createMember = async (
  id: string, content: string, ...typeIds: readonly string[]
): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId: 'p', orderKey: 'b0',
      content,
      properties: typesProperty(...typeIds),
    })
  }, {scope: ChangeScope.BlockDefault})
  await env.repo.awaitProcessors()
}

const indexedTypes = async (id: string): Promise<string[]> => {
  const rows = await env.h.db.getAll<{type: string}>(
    'SELECT type FROM block_types WHERE block_id = ? ORDER BY type', [id])
  return rows.map(row => row.type)
}

describe('core.retargetMergedTypeMembership', () => {
  beforeEach(async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    await createTypeDefinition(env.repo, TYPE_A, 'Dancer', 'a1')
    await createTypeDefinition(env.repo, TYPE_B, 'Person', 'a2')
    await env.repo.awaitProcessors()
  })

  // THE bug: merging two type-definition pages (the alias-collision
  // "Merge into…" flow) tombstoned `from` and left every block tagged with it
  // carrying a token that resolves through nothing — silently un-typed, with
  // nothing downstream to repair it.
  it('moves members of a merged-away type onto the survivor', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        content: 'Fred Astaire',
        properties: typesProperty(TYPE_A),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

    expect(env.read(TYPE_A)!.deleted).toBe(true)
    expect(getBlockTypes(env.read(MEMBER)!)).toEqual([TYPE_B])
    // The trigger-maintained membership index is what every by-type query
    // joins through, so this is the assertion that the block is findable again.
    expect(await indexedTypes(MEMBER)).toEqual([TYPE_B])
  })

  it('retargets atomically with the merge, in the merge tx', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        properties: typesProperty(TYPE_A),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    // No `awaitProcessors` — a post-commit repair would not have run yet, and
    // the window before it is exactly when a by-type query reads the row.
    await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})
    expect(await indexedTypes(MEMBER)).toEqual([TYPE_B])
  })

  it('collapses to one tag when a member carried both types', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        properties: typesProperty(TYPE_A, TYPE_B),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

    expect(getBlockTypes(env.read(MEMBER)!)).toEqual([TYPE_B])
  })

  it('preserves unrelated tags and their order', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        properties: typesProperty('todo', TYPE_A, 'page'),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

    expect(getBlockTypes(env.read(MEMBER)!)).toEqual(['todo', TYPE_B, 'page'])
  })

  // A merge whose survivor is an ordinary block still moves the pointer rather
  // than dropping the tag: dropping is unrecoverable, whereas a token naming a
  // live block is undoable with the merge and becomes real membership again if
  // that block is later made a type.
  it('retargets onto a non-type survivor instead of dropping membership', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: OTHER, workspaceId: WS, parentId: 'p', orderKey: 'b1', content: 'Plain page'})
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        properties: typesProperty(TYPE_A),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.merge({intoId: OTHER, fromId: TYPE_A, contentStrategy: 'keepTarget'})

    expect(getBlockTypes(env.read(MEMBER)!)).toEqual([OTHER])
  })

  it('leaves membership cells untouched when neither merged block is a type', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: OTHER, workspaceId: WS, parentId: 'p', orderKey: 'b1', content: 'Plain page'})
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        content: 'Tagged',
        properties: typesProperty(TYPE_A),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()
    const before = env.read(MEMBER)!

    await env.repo.mutate.merge({intoId: TYPE_B, fromId: OTHER, contentStrategy: 'keepTarget'})
    await env.repo.awaitProcessors()

    const after = env.read(MEMBER)!
    expect(after.properties[typesProp.name]).toEqual(before.properties[typesProp.name])
    // No write at all — not merely an equal value. A membership retarget is
    // derived bookkeeping and must not bump a bystander's row version.
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('does not float members into "recent" or rewrite their attribution', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: MEMBER, workspaceId: WS, parentId: 'p', orderKey: 'b0',
        properties: typesProperty(TYPE_A),
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()
    const before = env.read(MEMBER)!

    await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

    const after = env.read(MEMBER)!
    expect(getBlockTypes(after)).toEqual([TYPE_B])
    expect(after.userUpdatedAt).toBe(before.userUpdatedAt)
    // `updatedAt` DOES advance — `properties_json` is a synced column, so the
    // rewrite needs a new row version or a peer's LWW gate would drop it.
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  // Malformed `types` cells, which only a SYNC-APPLIED row can carry: every
  // local write path decodes `types` (typeify's `addedTypes`) and throws, but a
  // synced row bypasses the same-tx pass while the `block_types` triggers still
  // index it. A raw insert leaves `tx_context.source` NULL — the same shape a
  // synced row has.
  describe('sync-applied malformed membership cells', () => {
    const insertRawMember = async (typesJson: unknown): Promise<void> => {
      await env.h.db.writeTransaction(async tx => {
        await tx.execute(
          `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                               properties_json, references_json, created_at, updated_at,
                               created_by, updated_by, deleted)
           VALUES (?, ?, 'p', 'b0', 'Synced member', ?, '[]', 1, 1, 'peer', 'peer', 0)`,
          [MEMBER, WS, JSON.stringify({[typesProp.name]: typesJson})],
        )
      })
    }

    const storedTypes = async (id: string): Promise<unknown> => {
      const row = await env.h.db.get<{properties_json: string}>(
        'SELECT properties_json FROM blocks WHERE id = ?', [id])
      return (JSON.parse(row.properties_json) as Record<string, unknown>)[typesProp.name]
    }

    // Both malformed shapes are left strictly alone, and the merge must still
    // succeed. Not squeamishness: ANY write to such a row dirties it for
    // typeify's `rerunOnDirtyRows` pass, which decodes the row's BEFORE
    // snapshot — the malformed value regardless of what we wrote — and throws,
    // rolling the merge back. Retargeting these rows is impossible in-tx; they
    // are left for the audit query and an out-of-tx repair.
    //
    // `json_each` over a SCALAR yields the scalar, so a scalar cell IS indexed
    // as a real membership and does reach the processor.
    it('leaves a scalar cell alone rather than aborting the merge', async () => {
      await insertRawMember(TYPE_A)
      expect(await indexedTypes(MEMBER)).toEqual([TYPE_A])

      await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

      expect(env.read(TYPE_A)!.deleted).toBe(true)
      expect(await storedTypes(MEMBER)).toBe(TYPE_A)
    })

    it('leaves a cell holding a non-string entry alone rather than aborting the merge', async () => {
      await insertRawMember([TYPE_A, 7])

      await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

      expect(env.read(TYPE_A)!.deleted).toBe(true)
      expect(await storedTypes(MEMBER)).toEqual([TYPE_A, 7])
    })

    it('ignores a non-string entry in a cell that never named the merged-away type', async () => {
      await insertRawMember([TYPE_B, 7])

      await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

      expect(await storedTypes(MEMBER)).toEqual([TYPE_B, 7])
    })
  })

  // Processors run after the whole user fn, so in a chained merge the first
  // event's `intoId` is ALREADY a tombstone by the time it is handled. Both
  // naive answers strand the members (retarget onto the dead middle block, or
  // bail and leave them on the dead source), so the chain has to be resolved.
  describe('chained merges in one tx', () => {
    const TYPE_C = '5555eeee-5555-4555-8555-555555555555'

    beforeEach(async () => {
      await createTypeDefinition(env.repo, TYPE_C, 'Human', 'a3')
      await env.repo.awaitProcessors()
    })

    const chainMerge = async (): Promise<void> => {
      await env.repo.tx(async tx => {
        const requireBlock = async (id: string): Promise<BlockData> => {
          const row = await tx.get(id)
          if (row === null) throw new Error(`missing ${id}`)
          return row
        }
        await mergeBlocksInTx(tx, {
          into: await requireBlock(TYPE_B),
          from: await requireBlock(TYPE_A),
          contentStrategy: 'keepTarget',
        })
        await mergeBlocksInTx(tx, {
          into: await requireBlock(TYPE_C),
          from: await requireBlock(TYPE_B),
          contentStrategy: 'keepTarget',
        })
      }, {scope: ChangeScope.BlockDefault})
    }

    it('lands a member of the first source on the terminal survivor', async () => {
      await createMember(MEMBER, 'Member of A', TYPE_A)

      await chainMerge()

      expect(getBlockTypes(env.read(MEMBER)!)).toEqual([TYPE_C])
      expect(await indexedTypes(MEMBER)).toEqual([TYPE_C])
    })

    // Each event re-reads its members through `tx.get`, so the second merge's
    // rewrite composes with the first instead of clobbering it — and the two
    // tokens collapse to one because they now name the same survivor.
    it('collapses a member tagged with BOTH merged-away types to a single tag', async () => {
      await createMember(MEMBER, 'Member of A and B', TYPE_A, TYPE_B)

      await chainMerge()

      expect(getBlockTypes(env.read(MEMBER)!)).toEqual([TYPE_C])
    })
  })

  // `bt.type = fromId` does NOT prove the merged-away block owned that token:
  // membership tokens and block ids are both unrestricted strings, and a seeded
  // type needs no backing block at its token. Without a source gate, merging an
  // ordinary block that merely CARRIES the id `todo` would sweep up every member
  // of the seeded Todo type and retag them onto its survivor.
  describe('source ownership', () => {
    const SEEDED_TOKEN = 'todo'
    const IMPOSTOR = SEEDED_TOKEN
    const SURVIVOR = '7777ffff-7777-4777-8777-777777777777'

    it('does not retag members of a seeded type when an unrelated block shares its token', async () => {
      // A block whose id happens to equal a seeded membership token, and a
      // genuine member of that seeded type.
      await env.repo.tx(async tx => {
        await tx.create({
          id: IMPOSTOR, workspaceId: WS, parentId: 'p', orderKey: 'c0',
          content: 'a plain block that happens to be id "todo"',
        })
        await tx.create({
          id: SURVIVOR, workspaceId: WS, parentId: 'p', orderKey: 'c1',
          content: 'unrelated survivor',
        })
      }, {scope: ChangeScope.BlockDefault})
      await createMember(MEMBER, 'a real todo', SEEDED_TOKEN)
      expect(await indexedTypes(MEMBER)).toEqual([SEEDED_TOKEN])

      await env.repo.mutate.merge({
        intoId: SURVIVOR, fromId: IMPOSTOR, contentStrategy: 'keepTarget'})

      // Untouched: the merged block was never a type definition.
      expect(getBlockTypes(env.read(MEMBER)!)).toEqual([SEEDED_TOKEN])
      expect(await indexedTypes(MEMBER)).toEqual([SEEDED_TOKEN])
    })
  })

  // The source gate reads `types` off the merge SOURCE. Doing that through
  // `hasBlockType` would throw on a malformed synced cell and roll the merge
  // back — while this same processor deliberately tolerates that shape on every
  // member row. Same tolerance both sides.
  it('survives a malformed types cell on the merge source', async () => {
    const RAW_SOURCE = '8888aaaa-8888-4888-8888-888888888888'
    // Raw insert = the shape a SYNC-APPLIED row has: the triggers maintain the
    // side indexes, but no same-tx processor ever validated the cell.
    await env.h.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                             properties_json, references_json, created_at, updated_at,
                             created_by, updated_by, deleted)
         VALUES (?, ?, 'p', 'c9', 'malformed source', ?, '[]', 1, 1, 'peer', 'peer', 0)`,
        [RAW_SOURCE, WS, JSON.stringify({[typesProp.name]: BLOCK_TYPE_TYPE})])
    })

    await expect(env.repo.mutate.merge({
      intoId: TYPE_B, fromId: RAW_SOURCE, contentStrategy: 'keepTarget'})).resolves.not.toThrow()

    expect(env.read(RAW_SOURCE)!.deleted).toBe(true)
  })

  // Tolerating the malformed cell must not mean BELIEVING it. Reading a scalar
  // `types: "block-type"` as the list `["block-type"]` let a malformed ordinary
  // block pass the ownership gate — the gate that exists to stop a
  // non-definition from mass-retagging a type's members. The codec and the type
  // registry both reject that row as a type; this has to agree with them.
  // The destination must be a block with its OWN valid `types` cell: that is
  // what makes the merge complete at all. Merging into a block that LACKS the
  // key copies the malformed cell onto it, and typeify then throws while
  // decoding — so that variant aborts before this processor is ever consulted,
  // and cannot exercise the gate.
  it('does not treat a malformed source cell as proof it was a type definition', async () => {
    const RAW_SOURCE = '9999bbbb-9999-4999-8999-999999999999'
    // A member carrying the malformed block's id as a token — imported data can
    // do this. Without the fix this is what gets silently retagged.
    await createMember(MEMBER, 'carries the raw source id as a token', RAW_SOURCE)
    await env.h.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                             properties_json, references_json, created_at, updated_at,
                             created_by, updated_by, deleted)
         VALUES (?, ?, 'p', 'd0', 'malformed non-definition', ?, '[]', 1, 1, 'peer', 'peer', 0)`,
        [RAW_SOURCE, WS, JSON.stringify({[typesProp.name]: BLOCK_TYPE_TYPE})])
    })

    await env.repo.mutate.merge({
      intoId: TYPE_B, fromId: RAW_SOURCE, contentStrategy: 'keepTarget'})

    // Untouched: a malformed cell is not evidence that this block was the type
    // definition owning that token.
    expect(getBlockTypes(env.read(MEMBER)!)).toEqual([RAW_SOURCE])
  })

  // `block_types` structurally cannot see these rows (its update trigger
  // re-inserts only `WHEN deleted = 0`), so without the separate tombstone
  // sweep a restore after the merge resurrects the block silently un-typed.
  describe('tombstoned members', () => {
    it('retargets a member that was already deleted when the merge ran', async () => {
      await createMember(MEMBER, 'Deleted member of A', TYPE_A)
      await env.repo.tx(async tx => {
        await tx.delete(MEMBER)
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.awaitProcessors()
      expect(await indexedTypes(MEMBER)).toEqual([])

      await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})

      // Still a tombstone — the rewrite touches the bag, never `deleted`.
      expect(env.read(MEMBER)!.deleted).toBe(true)
      expect(getBlockTypes(env.read(MEMBER)!)).toEqual([TYPE_B])
    })

    it('gives a restored member live membership again', async () => {
      await createMember(MEMBER, 'Deleted member of A', TYPE_A)
      await env.repo.tx(async tx => {
        await tx.delete(MEMBER)
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.awaitProcessors()

      await env.repo.mutate.merge({intoId: TYPE_B, fromId: TYPE_A, contentStrategy: 'keepTarget'})
      await env.repo.awaitProcessors()

      await env.repo.mutate.restore({id: MEMBER})
      await env.repo.awaitProcessors()
      expect(env.read(MEMBER)!.deleted).toBe(false)

      // The whole point: the index rebuilt from the restored bag names the
      // SURVIVOR. Before the tombstone sweep this came back as the dead TYPE_A.
      expect(await indexedTypes(MEMBER)).toEqual([TYPE_B])
    })
  })
})
