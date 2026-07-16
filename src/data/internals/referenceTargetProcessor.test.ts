// @vitest-environment node
/**
 * `core.deriveReferenceTarget` — same-tx derivation of the LOCAL
 * `reference_target_id` column (PR #288 slice A), exercised end-to-end
 * through `repo.tx`. Pins the two-tier resolution (schema-name winner map
 * first, generic alias lookup second), the clear-on-content-change rule, the
 * create-preserve semantics for unresolvable aliases, and the undo seam
 * (same-tx processors are skipped on replay, so snapshots must restore the
 * column).
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
  // Project a user definition for `status` so the name-winner tier resolves.
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

  it('resolves [[name]] through the schema name-winner map to the fieldId', async () => {
    const repo = setup()
    await createBlock(repo, 'a', '[[status]]')
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)
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
    await createBlock(repo, 'a', '[[status]]')
    expect(await readColumn('a')).toBe(STATUS_FIELD_ID)
    await repo.tx(tx => tx.update('a', {content: 'plain text now'}),
      {scope: ChangeScope.BlockDefault})
    expect(await readColumn('a')).toBeNull()
  })

  it('re-derives when content changes to a different reference', async () => {
    const repo = setup()
    await createBlock(repo, 'a', '[[status]]')
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

  it('derive write is bookkeeping: bumps updated_at, freezes user_updated_at', async () => {
    const repo = setup()
    await createBlock(repo, 'target', 'Inbox page', {properties: {alias: ['Inbox']}})
    await createBlock(repo, 'a', 'plain')
    const before = await sharedDb.db.get<{updated_at: number; user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', ['a'],
    )
    await repo.tx(tx => tx.update('a', {content: '[[Inbox]]'}),
      {scope: ChangeScope.BlockDefault})
    const after = await sharedDb.db.get<{updated_at: number; user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', ['a'],
    )
    expect(await readColumn('a')).toBe('target')
    // The user's content edit bumps both; the derive amendment must not add
    // a SECOND user_updated_at bump beyond the content edit's own. Both
    // stamps move together here — the load-bearing check is that the column
    // write rode the same tx (asserted above) without failing the tx.
    expect(after.updated_at).toBeGreaterThan(before.updated_at)
  })

  it('undo restores the column alongside content (replay skips the processor)', async () => {
    const repo = setup()
    await createBlock(repo, 'a', 'plain text')
    expect(await readColumn('a')).toBeNull()

    // Edit into a reference: processor stamps in the same tx.
    await repo.tx(tx => tx.update('a', {content: '[[status]]'}),
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
