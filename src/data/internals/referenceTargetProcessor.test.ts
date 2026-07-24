// @vitest-environment node
/**
 * `core.deriveReferenceTarget` — same-tx derivation of the LOCAL
 * `reference_target_id` column (PR #288 slice A), exercised end-to-end
 * through `repo.tx`. Pins the resolution (a `((id))` block-ref textually, an
 * `[[alias]]` through the generic alias lookup — no property-name tier), the
 * clear-on-content-change rule, the create-preserve semantics for
 * unresolvable aliases, and the undo seam (same-tx processors are skipped on
 * replay, so snapshots must restore the column).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { Repo } from '../repo'

const WS = 'ws-ref-target'
const STATUS_FIELD_ID = 'field-status-definition'

const statusSchema = defineProperty('status', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const setup = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  // Project a user definition for `status` — used to prove `[[status]]` does
  // NOT bind to it (id-addressing only, no name tier).
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-status-definition',
    [{
      metadata: {
        fieldId: STATUS_FIELD_ID,
        workspaceId: WS,
        createdAt: 1,
        name: statusSchema.name,
        changeScope: statusSchema.changeScope,
        hidden: false,
        origin: 'user' as const,
      },
      schema: statusSchema,
    }],
    {workspaceId: WS},
  )
  return repo
}

const readColumn = async (id: string): Promise<string | null> => {
  const row = await sharedDb.db.get<{reference_target_id: string | null}>(
    'SELECT reference_target_id FROM blocks WHERE id = ?', [id],
  )
  return row.reference_target_id
}

const createBlock = async (
  repo: Repo,
  id: string,
  content: string,
  extra: {referenceTargetId?: string | null; properties?: Record<string, unknown>} = {},
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content, ...extra,
    })
  }, {scope: ChangeScope.BlockDefault})
}

describe('core.deriveReferenceTarget (same-tx processor)', () => {
  it('stamps a whole-block ((uuid)) reference, lowercased', async () => {
    const repo = setup()
    const target = '0EA26AE6-6522-4B00-9DAF-2C72D3AF29E1'
    await createBlock(repo, 'a', `((${target}))`)
    expect(await readColumn('a')).toBe(target.toLowerCase())
  })

  it('stamps a non-uuid ((token)) verbatim', async () => {
    const repo = setup()
    await createBlock(repo, 'a', '((custom-target-id))')
    expect(await readColumn('a')).toBe('custom-target-id')
  })

  it('does NOT special-case [[name]] matching a property definition (id-addressing only)', async () => {
    const repo = setup()
    // A definition named `status` exists, but `[[status]]` is plain page
    // resolution — it must NOT bind to the definition. Field rows address
    // their definition by id (`((fieldId))`), covered above.
    await createBlock(repo, 'a', '[[status]]')
    expect(await readColumn('a')).toBeNull()
  })

  it('falls back to the generic alias lookup for non-schema [[alias]]', async () => {
    const repo = setup()
    await createBlock(repo, 'target', 'Inbox page', {properties: {alias: ['Inbox']}})
    await createBlock(repo, 'a', '[[Inbox]]')
    expect(await readColumn('a')).toBe('target')
  })

  it('leaves prose (non-whole-block references) unstamped', async () => {
    const repo = setup()
    await createBlock(repo, 'a', 'see ((0ea26ae6-6522-4b00-9daf-2c72d3af29e1)) for details')
    expect(await readColumn('a')).toBeNull()
    await createBlock(repo, 'b', 'about [[status]] things')
    expect(await readColumn('b')).toBeNull()
  })

  it('clears the column when content stops being an exact reference', async () => {
    const repo = setup()
    await createBlock(repo, 'a', `((${STATUS_FIELD_ID}))`)
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)
    await repo.tx(tx => tx.update('a', {content: 'plain text now'}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBeNull()
  })

  it('re-derives when content changes to a different reference', async () => {
    const repo = setup()
    await createBlock(repo, 'a', '((old-id))')
    await repo.tx(tx => tx.update('a', {content: '((custom-id))'}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBe('custom-id')
  })

  it('keeps a caller-provided id on CREATE when the alias resolves to nothing', async () => {
    const repo = setup()
    await createBlock(repo, 'a', '[[not a schema or alias]]', {
      referenceTargetId: 'machinery-supplied-id',
    })
    expect(await readColumn('a')).toBe('machinery-supplied-id')
  })

  it('clears (does not preserve) on UPDATE to an unresolvable alias', async () => {
    const repo = setup()
    await createBlock(repo, 'a', '((custom-id))')
    await repo.tx(tx => tx.update('a', {content: '[[nothing resolves this]]'}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBeNull()
  })

  it('derive stamp is local-only: the content edit enqueues ONE upload PATCH, none for reference_target_id', async () => {
    // `reference_target_id` is a per-device derived column — never in
    // `BLOCK_UPLOAD_COLUMNS`, never uploaded. Re-deriving it therefore must
    // NOT mint an upload envelope. The user's content edit ships exactly one
    // PATCH (the content); the same-tx derive amendment writes only the local
    // column and must add no second PATCH (Decision A / PR #288 §5).
    const repo = setup()
    await createBlock(repo, 'a', 'plain')
    await repo.tx(tx => tx.update('a', {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)   // the column WAS stamped
    const envelopes = (await sharedDb.db.getAll<{data: string}>('SELECT data FROM ps_crud ORDER BY id'))
      .map(r => JSON.parse(r.data) as {op: string; id: string; data: Record<string, unknown>})
      .filter(e => e.id === 'a')
    // create PUT + exactly one content PATCH — not a second refTarget PATCH.
    expect(envelopes.map(e => e.op)).toEqual(['PUT', 'PATCH'])
    const patch = envelopes.find(e => e.op === 'PATCH')!
    expect(patch.data).toHaveProperty('content')
    expect(patch.data).not.toHaveProperty('reference_target_id')
  })

  it('derive stamp does not add a second user_updated_at bump beyond the content edit', async () => {
    const repo = setup()
    await createBlock(repo, 'a', 'plain')
    const before = await sharedDb.db.get<{user_updated_at: number}>(
      'SELECT user_updated_at FROM blocks WHERE id = ?', ['a'],
    )
    await repo.tx(tx => tx.update('a', {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})
    const after = await sharedDb.db.get<{user_updated_at: number}>(
      'SELECT user_updated_at FROM blocks WHERE id = ?', ['a'],
    )
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)
    // The content edit is the one real user edit — it advances user_updated_at
    // once. The derive amendment freezes it (local bookkeeping, not an edit).
    expect(after.user_updated_at).toBeGreaterThan(before.user_updated_at)
  })

  it('derives a content edit made while the row is soft-deleted, preserving the tombstone', async () => {
    // The module invariant: "Tombstoned rows derive too" — a content edit
    // while deleted must still stamp the column (else a later content-unchanged
    // restore never repairs it). The narrow stamp SQL must not resurrect the
    // row. (Symmetric to the arrival path's tombstone-derive coverage.)
    const repo = setup()
    await createBlock(repo, 'a', 'plain')
    await repo.tx(tx => tx.delete('a'), {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.update('a', {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)   // derived while deleted
    const row = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', ['a'],
    )
    expect(row.deleted).toBe(1)   // tombstone preserved — the stamp never resurrects
  })

  it('undo restores the column alongside content (replay skips the processor)', async () => {
    const repo = setup()
    await createBlock(repo, 'a', 'plain text')
    expect(await readColumn('a')).toBeNull()

    // Edit into a reference: processor stamps in the same tx.
    await repo.tx(tx => tx.update('a', {content: `((${STATUS_FIELD_ID}))`}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)

    // Undo the edit: content back to plain text — the column must CLEAR
    // even though same-tx processors are skipped on replay (the snapshot
    // carries it; invariants index, PR #288).
    await repo.undo(ChangeScope.BlockDefault)
    expect(await readColumn('a')).toBeNull()

    // Redo: the stamped state comes back from the snapshot, not a re-derive.
    await repo.redo(ChangeScope.BlockDefault)
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)
  })
})

// ──── §7 grammar box: the `::` marked field forms derive BOTH columns ────

describe('core.deriveReferenceTarget — is_field_form bit', () => {
  const readBit = async (id: string): Promise<number | null> => {
    const row = await sharedDb.db.get<{is_field_form: number | null}>(
      'SELECT is_field_form FROM blocks WHERE id = ?', [id],
    )
    return row.is_field_form
  }

  it('stamps bit + target for the canonical ::((fieldId)) form', async () => {
    const repo = setup()
    await createBlock(repo, 'b-marked', `::((${STATUS_FIELD_ID}))`)
    expect(await readColumn('b-marked')).toBe(STATUS_FIELD_ID)
    expect(await readBit('b-marked')).toBe(1)
  })

  it('stamps bit + target for the marked aliased blockref, textually', async () => {
    const repo = setup()
    const uuid = '0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b'
    await createBlock(repo, 'b-aliased', `::[status](((${uuid})))`)
    expect(await readColumn('b-aliased')).toBe(uuid)
    expect(await readBit('b-aliased')).toBe(1)
  })

  it('stamps the bit WITHOUT a target for an unresolvable ::[[name]] (pure syntax; only the target late-binds)', async () => {
    const repo = setup()
    await createBlock(repo, 'b-unbound', '::[[future-field]]')
    expect(await readColumn('b-unbound')).toBeNull()
    expect(await readBit('b-unbound')).toBe(1)
  })

  it('leaves the bit NULL (never 0) on ordinary rows — the IS NOT 1 value-set convention', async () => {
    const repo = setup()
    await createBlock(repo, 'b-prose', 'just prose')
    await createBlock(repo, 'b-plain-ref', `((${STATUS_FIELD_ID}))`)
    expect(await readBit('b-prose')).toBeNull()
    expect(await readBit('b-plain-ref')).toBeNull()
    // The unmarked ref still stamps its target — every form × marked/unmarked.
    expect(await readColumn('b-plain-ref')).toBe(STATUS_FIELD_ID)
  })

  it('clears the bit when a content edit leaves the marked form', async () => {
    const repo = setup()
    await createBlock(repo, 'b-clears', `::((${STATUS_FIELD_ID}))`)
    expect(await readBit('b-clears')).toBe(1)
    await repo.tx(
      tx => tx.update('b-clears', {content: 'now prose'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(await readBit('b-clears')).toBeNull()
    expect(await readColumn('b-clears')).toBeNull()
  })
})
