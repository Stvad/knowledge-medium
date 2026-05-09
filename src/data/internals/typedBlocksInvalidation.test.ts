// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { ChangeSnapshot } from '@/data/invalidation'

import {
  TYPED_BLOCKS_LIVE_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  emitTypedBlocksInvalidations,
  typedBlocksLiveKey,
  typedBlocksPropertyKey,
  typedBlocksReferenceFieldKey,
  typedBlocksReferenceKey,
  typedBlocksTypeKey,
} from './typedBlocksInvalidation'

const WS = 'ws-1'

interface SidePatch {
  parentId?: string | null
  workspaceId?: string
  deleted?: boolean
  references?: ReadonlyArray<{ id: string; sourceField?: string }>
  properties?: Readonly<Record<string, unknown>>
}

const side = (patch: SidePatch | null = {}): ChangeSnapshot['after'] => {
  if (patch === null) return null
  return {
    parentId: patch.parentId ?? null,
    workspaceId: patch.workspaceId ?? WS,
    deleted: patch.deleted,
    references: patch.references,
    properties: patch.properties,
  }
}

const collect = (snapshot: ChangeSnapshot): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  emitTypedBlocksInvalidations(snapshot, (channel, key) => {
    out.push([channel, key])
  })
  return out
}

describe('emitTypedBlocksInvalidations', () => {
  it('emits live + per-axis channels on row creation', () => {
    const out = collect({
      before: null,
      after: side({
        properties: {
          types: ['note', 'page'],
          status: 'open',
        },
        references: [{ id: 't1', sourceField: 'rel' }, { id: 't2' }],
      }),
    })
    expect(out).toEqual(expect.arrayContaining([
      [TYPED_BLOCKS_LIVE_CHANNEL, typedBlocksLiveKey(WS)],
      [TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(WS, 'note')],
      [TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(WS, 'page')],
      [TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'types')],
      [TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'status')],
      [TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(WS, 't1')],
      [TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(WS, 't1', 'rel')],
      [TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(WS, 't2')],
    ]))
  })

  it('emits live + per-axis channels on soft-delete (from live before)', () => {
    const out = collect({
      before: side({
        properties: { types: ['note'], status: 'open' },
        references: [{ id: 't1' }],
      }),
      after: side({
        deleted: true,
        properties: { types: ['note'], status: 'open' },
      }),
    })
    expect(out).toEqual(expect.arrayContaining([
      [TYPED_BLOCKS_LIVE_CHANNEL, typedBlocksLiveKey(WS)],
      [TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(WS, 'note')],
      [TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'status')],
      [TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(WS, 't1')],
    ]))
  })

  it('emits live + per-axis channels on restore (deleted → live)', () => {
    const out = collect({
      before: side({ deleted: true, properties: { types: ['note'] } }),
      after: side({ properties: { types: ['note'] } }),
    })
    expect(out).toEqual(expect.arrayContaining([
      [TYPED_BLOCKS_LIVE_CHANNEL, typedBlocksLiveKey(WS)],
      [TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(WS, 'note')],
    ]))
  })

  it('emits per-axis only when liveness unchanged + content edit only', () => {
    const out = collect({
      before: side({ properties: { types: ['note'], content: 'a' } }),
      after: side({ properties: { types: ['note'], content: 'b' } }),
    })
    // Type list unchanged, only `content` property differs.
    expect(out).toEqual([[TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'content')]])
    // Critically: no live, no type channel.
    expect(out.find(([ch]) => ch === TYPED_BLOCKS_LIVE_CHANNEL)).toBeUndefined()
    expect(out.find(([ch]) => ch === TYPED_BLOCKS_TYPE_CHANNEL)).toBeUndefined()
  })

  it('emits added + removed types when type list changes on a live row', () => {
    const out = collect({
      before: side({ properties: { types: ['note', 'task'] } }),
      after: side({ properties: { types: ['note', 'page'] } }),
    })
    expect(out).toEqual(expect.arrayContaining([
      [TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(WS, 'task')],
      [TYPED_BLOCKS_TYPE_CHANNEL, typedBlocksTypeKey(WS, 'page')],
    ]))
    // `note` is on both sides → no emit.
    expect(out.filter(([_, key]) => key === typedBlocksTypeKey(WS, 'note'))).toEqual([])
  })

  it('emits property channel only for the property name that changed', () => {
    const out = collect({
      before: side({ properties: { status: 'open', priority: 1 } }),
      after: side({ properties: { status: 'open', priority: 2 } }),
    })
    expect(out).toEqual([[TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'priority')]])
  })

  it('emits property channel for unset → set transitions', () => {
    const out = collect({
      before: side({ properties: { } }),
      after: side({ properties: { status: 'open' } }),
    })
    expect(out).toEqual([[TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'status')]])
  })

  it('emits property channel for set → unset transitions', () => {
    const out = collect({
      before: side({ properties: { status: 'open' } }),
      after: side({ properties: { } }),
    })
    expect(out).toEqual([[TYPED_BLOCKS_PROPERTY_CHANNEL, typedBlocksPropertyKey(WS, 'status')]])
  })

  it('emits reference channels only for added/removed pairs (not for unchanged refs)', () => {
    const out = collect({
      before: side({ references: [{ id: 't1' }, { id: 't2', sourceField: 'rel' }] }),
      after: side({ references: [{ id: 't1' }, { id: 't3' }] }),
    })
    // t2/rel removed, t3 added; t1 unchanged.
    expect(out).toEqual(expect.arrayContaining([
      [TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(WS, 't2')],
      [TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(WS, 't2', 'rel')],
      [TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(WS, 't3')],
    ]))
    expect(out.filter(([_, key]) => key === typedBlocksReferenceKey(WS, 't1'))).toEqual([])
  })

  it('does not double-emit when the same target appears with multiple sourceFields', () => {
    const out = collect({
      before: side({ references: [] }),
      after: side({ references: [
        { id: 't1', sourceField: 'a' },
        { id: 't1', sourceField: 'b' },
      ] }),
    })
    const targetEmits = out.filter(([_, key]) => key === typedBlocksReferenceKey(WS, 't1'))
    expect(targetEmits).toHaveLength(1)
    const fieldEmits = out.filter(([ch]) => ch === TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL)
    expect(fieldEmits).toHaveLength(2)
  })

  it('skips emission entirely for both-deleted snapshots (re-tombstone)', () => {
    const out = collect({
      before: side({ deleted: true, properties: { types: ['note'] } }),
      after: side({ deleted: true, properties: { types: ['note'] } }),
    })
    expect(out).toEqual([])
  })

  it('returns nothing when neither side has a workspaceId', () => {
    const out = collect({
      before: { parentId: null, workspaceId: '' },
      after: { parentId: null, workspaceId: '' },
    })
    expect(out).toEqual([])
  })
})
