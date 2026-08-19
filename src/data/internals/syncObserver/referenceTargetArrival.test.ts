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
// Property field rows address their definition BY ID (`((fieldId))`, §7), so
// they resolve on the textual block-ref branch — no name→schema tier.
const STATUS_REF = `((${STATUS_FIELD_ID}))`

const h = setupObserverTestDb()

const lookups: ReferenceTargetLookups = {
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
    await h.stageRow(block({id: 'b1', content: STATUS_REF}))
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
    await h.stageRow(block({id: 'b1', content: STATUS_REF, updatedAt: 1000}))
    await observer.flush()
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)

    // Re-delivery with newer stamp, same content, different properties.
    await h.stageRow(block({
      id: 'b1', content: STATUS_REF, properties: {x: 1}, updatedAt: 2000,
    }))
    await observer.flush()
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)
    expect(cache.getSnapshot('b1')?.referenceTargetId).toBe(STATUS_FIELD_ID)
  })

  it('clears the column when arriving content stops being a reference', async () => {
    const {observer, cache} = startWithLookups()
    await h.stageRow(block({id: 'b1', content: STATUS_REF, updatedAt: 1000}))
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

  it('reports alias-gaining arrivals to the deferred repair hook (§9 arrival-order hole)', async () => {
    // The referrer arrives BEFORE its target and derives to NULL; the
    // target's later arrival must hand its aliases to the repair executor
    // (a DEFERRED batched re-derive on Repo — never an in-tx scan: on a
    // fresh device every page arrival gains aliases). End-to-end repair is
    // pinned at the repo level (referenceTargetDerivePass.test.ts).
    const added: {workspaceId: string; aliases: readonly string[]}[] = []
    const withHook = h.start({
      getMaterializability: () => 'copy',
      referenceTargetLookups: () => lookups,
      onAliasTargetsAdded: (workspaceId, aliases) => { added.push({workspaceId, aliases}) },
    })

    await h.stageRow(block({id: 'ref', content: '[[Inbox]]', orderKey: 'a1'}))
    await withHook.observer.flush()
    expect(await readColumn('ref')).toBeNull()

    await h.stageRow(block({
      id: 'target', content: 'Inbox page', properties: {alias: ['Inbox']},
    }))
    await withHook.observer.flush()
    expect(added).toContainEqual({workspaceId: WS, aliases: ['Inbox']})
    // Re-delivery with the SAME aliases (content tweak) reports nothing new.
    added.length = 0
    await h.stageRow(block({
      id: 'target', content: 'Inbox page v2', properties: {alias: ['Inbox']}, updatedAt: 2000,
    }))
    await withHook.observer.flush()
    expect(added).toEqual([])
  })

  it('reports aliases on a tombstoned-then-restored arrival (restore makes the alias newly visible)', async () => {
    // The alias index is `WHERE deleted = 0`, so a target's aliases are
    // invisible while tombstoned — a restore is exactly when stale
    // `[[alias]]` NULL rows become repairable, so the SECOND (restoring)
    // arrival must report the aliases even though the properties never
    // changed across the two deliveries.
    const added: {workspaceId: string; aliases: readonly string[]}[] = []
    const withHook = h.start({
      getMaterializability: () => 'copy',
      referenceTargetLookups: () => lookups,
      onAliasTargetsAdded: (workspaceId, aliases) => { added.push({workspaceId, aliases}) },
    })

    await h.stageRow(block({
      id: 'target', content: 'Inbox page', properties: {alias: ['Inbox']}, deleted: true, updatedAt: 1000,
    }))
    await withHook.observer.flush()
    // Tombstoned arrivals contribute no aliases (materialize.ts skips
    // `snap.after.deleted` rows before diffing).
    expect(added).toEqual([])

    await h.stageRow(block({
      id: 'target', content: 'Inbox page', properties: {alias: ['Inbox']}, deleted: false, updatedAt: 2000,
    }))
    await withHook.observer.flush()
    expect(added).toContainEqual({workspaceId: WS, aliases: ['Inbox']})
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
      id: 'b1', content: STATUS_REF, referenceTargetId: STATUS_FIELD_ID, updatedAt: 1000,
    }))
    await h.stageRow(block({
      id: 'b1', content: STATUS_REF, properties: {touched: true}, updatedAt: 2000,
    }))
    await observer.flush()
    await vi.waitFor(async () => {
      expect((await h.allBlocks()).find(r => r.id === 'b1')?.updated_at).toBe(2000)
    })
    expect(await readColumn('b1')).toBe(STATUS_FIELD_ID)
  })
})
