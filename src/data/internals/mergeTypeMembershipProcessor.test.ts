// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
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
})
