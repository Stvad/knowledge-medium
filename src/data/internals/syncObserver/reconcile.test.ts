import { describe, expect, it } from 'vitest'
import type { BlockRow } from '@/data/blockSchema.js'
import {
  blocksAlreadyReflects,
  decideStagingRow,
  localHoldsStagedRow,
} from './reconcile.js'

const notPending = { hasPendingUpload: false }
const pending = { hasPendingUpload: true }

describe('decideStagingRow — materializability', () => {
  it('defers when the workspace is not materializable (locked / quarantine)', () => {
    expect(decideStagingRow('defer', notPending)).toEqual({ kind: 'defer' })
  })

  it('applies with decrypt for an e2ee workspace with the key loaded', () => {
    expect(decideStagingRow('decrypt', notPending)).toEqual({ kind: 'apply', decrypt: true })
  })

  it('does NOT defer a plaintext workspace just because it has no key', () => {
    // The bug the doc warns about: "skip any row whose workspace has no WK"
    // would strand plaintext rows forever.
    expect(decideStagingRow('copy', notPending)).toEqual({ kind: 'apply', decrypt: false })
  })

  it('defer takes precedence over a pending upload', () => {
    expect(decideStagingRow('defer', pending)).toEqual({ kind: 'defer' })
  })

  it('skips when an upload is pending for this id (echo will reconcile)', () => {
    expect(decideStagingRow('decrypt', pending)).toEqual({ kind: 'skip-stale' })
  })
})

const row = (overrides: Partial<BlockRow> = {}): BlockRow => ({
  id: 'b1',
  workspace_id: 'ws',
  parent_id: null,
  order_key: 'a0',
  content: 'v1',
  properties_json: '{}',
  references_json: '[]',
  created_at: 1,
  updated_at: 200,
  user_updated_at: 200,
  created_by: 'u',
  updated_by: 'u',
  deleted: 0,
  ...overrides,
})

describe('localHoldsStagedRow — the drain no-op test', () => {
  it('holds for an identical row — the echo of this device\'s own write', () => {
    expect(localHoldsStagedRow(row(), row())).toBe(true)
  })

  it('does NOT hold on an equal nonzero stamp when a column differs (#1163)', () => {
    // A peer write landing on a stamp this device already holds: same version,
    // different row. Skipping it would keep the stale row on disk for good.
    expect(localHoldsStagedRow(row({ content: 'mine' }), row({ content: 'theirs' }))).toBe(false)
    expect(localHoldsStagedRow(row({ user_updated_at: 1 }), row({ user_updated_at: 2 }))).toBe(false)
  })

  it('holds for an identical stamp-0 row, and not for a differing one', () => {
    expect(localHoldsStagedRow(row({ updated_at: 0 }), row({ updated_at: 0 }))).toBe(true)
    expect(localHoldsStagedRow(
      row({ updated_at: 0, created_at: 1 }), row({ updated_at: 0, created_at: 2 }),
    )).toBe(false)
  })

  it('ignores the local-only columns `blocks` carries and `blocks_synced` does not', () => {
    expect(localHoldsStagedRow(row({ reference_target_id: 'x', is_field_form: 1 }), row())).toBe(true)
  })

  it('does not hold with no local row', () => {
    expect(localHoldsStagedRow(null, row())).toBe(false)
    expect(localHoldsStagedRow(undefined, row())).toBe(false)
  })
})

describe('blocksAlreadyReflects — the same question without decoding', () => {
  it('lets a nonzero stamp vouch for the sealed columns it cannot read', () => {
    expect(blocksAlreadyReflects(row({ content: 'enc:v1:sealed' }), row({ content: 'plain' }))).toBe(true)
  })

  it('does not let the stamp vouch for a CLEAR column', () => {
    expect(blocksAlreadyReflects(row({ user_updated_at: 2 }), row({ user_updated_at: 1 }))).toBe(false)
    expect(blocksAlreadyReflects(row({ updated_at: 201 }), row())).toBe(false)
  })

  it('does not let stamp 0 vouch, but accepts an identical stamp-0 row', () => {
    expect(blocksAlreadyReflects(row({ updated_at: 0, content: 'a' }), row({ updated_at: 0, content: 'b' }))).toBe(false)
    expect(blocksAlreadyReflects(row({ updated_at: 0 }), row({ updated_at: 0 }))).toBe(true)
  })

  it('treats a tombstone invisible on both sides as reflected', () => {
    expect(blocksAlreadyReflects(row({ deleted: 1 }), undefined)).toBe(true)
    expect(blocksAlreadyReflects(row({ deleted: 1, updated_at: 9 }), row({ deleted: 1 }))).toBe(true)
    expect(blocksAlreadyReflects(row({ deleted: 1, updated_at: 9 }), row())).toBe(false)
  })
})
