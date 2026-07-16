// @vitest-environment node
/**
 * Derive-at-arrival for the LOCAL `reference_target_id` column (PR #288
 * slice A): sync-applied rows never pass through `repo.tx`, so the
 * materializer stamps the column for content-changed arrivals — inside the
 * Phase-2 write tx, before the invalidation fan-out — and preserves it on
 * content-unchanged arrivals (the UPSERT never touches local columns).
 */

import { describe, expect, it, vi } from 'vitest'
import type { BlockData } from '@/data/api'
import type { ReferenceTargetLookups } from '@/data/internals/referenceTargetProcessor'
import { setupObserverTestDb } from './test/harness'

const WS = 'ws-arrival'
const STATUS_FIELD_ID = 'field-status-arrival'

const h = setupObserverTestDb()

const lookups: ReferenceTargetLookups = {
  resolveSchemaFieldId: (_ws, name) => (name === 'status' ? STATUS_FIELD_ID : null),
  aliasTargetId: async () => null,
}

const block = (overrides: Partial<BlockData>): BlockData => ({
  id: 'b1',
  workspaceId: WS,
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 1,
  updatedAt: 1000,
  userUpdatedAt: 1000,
  createdBy: 'peer',
  updatedBy: 'peer',
  deleted: false,
  ...overrides,
})

const readColumn = async (id: string): Promise<string | null> => {
  const row = await h.env.db.get<{reference_target_id: string | null}>(
    'SELECT reference_target_id FROM blocks WHERE id = ?', [id],
  )
  return row.reference_target_id
}

const startWithLookups = () =>
  h.start({getMaterializability: () => 'copy', referenceTargetLookups: () => lookups})

describe('derive-at-arrival (sync materializer)', () => {
  it('stamps a fresh arrival whose content is an exact reference', async () => {
    const {observer, cache} = startWithLookups()
    await h.stageRow(block({id: 'b1', content: '[[status]]'}))
    await observer.flush()

    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)
    // The invalidation-visible snapshot must carry the derived value — the
    // staging row has no such column, so without the seam the cache would
    // hold null.
    expect(cache.getSnapshot('b1')?.referenceTargetId).toBe(STATUS_FIELD_ID)
  })

  it('stamps ((id)) block references at arrival', async () => {
    const {observer} = startWithLookups()
    await h.stageRow(block({id: 'b1', content: '((remote-target))'}))
    await observer.flush()
    expect(await readColumn('b1')).toBe('remote-target')
  })

  it('preserves the column on a content-unchanged arrival (metadata-only update)', async () => {
    const {observer, cache} = startWithLookups()
    await h.stageRow(block({id: 'b1', content: '[[status]]', updatedAt: 1000}))
    await observer.flush()
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)

    // Re-delivery with newer stamp, same content, different properties.
    await h.stageRow(block({
      id: 'b1', content: '[[status]]', properties: {x: 1}, updatedAt: 2000,
    }))
    await observer.flush()
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)
    expect(cache.getSnapshot('b1')?.referenceTargetId).toBe(STATUS_FIELD_ID)
  })

  it('clears the column when arriving content stops being a reference', async () => {
    const {observer, cache} = startWithLookups()
    await h.stageRow(block({id: 'b1', content: '[[status]]', updatedAt: 1000}))
    await observer.flush()
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)

    await h.stageRow(block({id: 'b1', content: 'plain text now', updatedAt: 2000}))
    await observer.flush()
    expect(await readColumn('b1')).toBeNull()
    expect(cache.getSnapshot('b1')?.referenceTargetId).toBeNull()
  })

  it('derives tombstoned arrivals too (content edit while deleted)', async () => {
    const {observer} = startWithLookups()
    await h.stageRow(block({id: 'b1', content: '((old-target))', updatedAt: 1000}))
    await observer.flush()

    await h.stageRow(block({
      id: 'b1', content: '((new-target))', deleted: true, updatedAt: 2000,
    }))
    await observer.flush()
    expect(await readColumn('b1')).toBe('new-target')
  })

  it('same-window alias arrivals resolve (derive runs after every upsert)', async () => {
    // The lookups read through the OPEN write tx (the seam's contract): a
    // same-window alias target's index rows are uncommitted until the drain
    // tx commits, so an outer-connection read would miss them.
    const withAlias = h.start({
      getMaterializability: () => 'copy',
      referenceTargetLookups: tx => ({
        resolveSchemaFieldId: () => null,
        aliasTargetId: async (alias) => {
          const row = await tx.getOptional<{block_id: string}>(
            'SELECT block_id FROM block_aliases WHERE workspace_id = ? AND alias = ?',
            [WS, alias],
          )
          return row?.block_id ?? null
        },
      }),
    })

    // Target (with its alias) and the referencing row staged in ONE window:
    // the alias-index triggers fire on the target's upsert, so the derive
    // loop — which runs after all upserts — resolves the reference.
    await h.stageRow(block({
      id: 'target', content: 'Inbox page', properties: {alias: ['Inbox']},
    }))
    await h.stageRow(block({id: 'ref', content: '[[Inbox]]', orderKey: 'a1'}))
    await withAlias.observer.flush()

    expect(await readColumn('ref')).toBe('target')
  })

  it('skips derivation entirely when the lookups dep is absent', async () => {
    const {observer} = h.start({getMaterializability: () => 'copy'})
    await h.stageRow(block({id: 'b1', content: '((remote-target))'}))
    await observer.flush()
    expect(await readColumn('b1')).toBeNull()
  })

  it('a local processor-stamped column survives unrelated sync arrivals', async () => {
    // Simulates the upgrade-path interaction: the column was stamped locally
    // (here: seeded directly), then a remote metadata edit arrives — the
    // UPSERT's DO UPDATE lists only storage columns, so the local value must
    // survive even though the staged row knows nothing about it.
    const {observer} = startWithLookups()
    await h.seedLocalBlock(block({
      id: 'b1', content: '[[status]]', referenceTargetId: STATUS_FIELD_ID, updatedAt: 1000,
    }))
    await h.stageRow(block({
      id: 'b1', content: '[[status]]', properties: {touched: true}, updatedAt: 2000,
    }))
    await observer.flush()
    await vi.waitFor(async () => {
      expect((await h.allBlocks()).find(r => r.id === 'b1')?.updated_at).toBe(2000)
    })
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)
  })
})
