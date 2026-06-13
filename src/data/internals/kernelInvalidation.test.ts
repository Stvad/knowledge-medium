// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { ChangeSnapshot } from '@/data/invalidation'

import { emitKernelInvalidations } from './kernelInvalidation'
import {
  KERNEL_ALIASES_CHANNEL,
  KERNEL_CONTENT_CHANNEL,
  TYPED_BLOCKS_LIVE_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  kernelAliasesKey,
  kernelContentKey,
  typedBlocksLiveKey,
  typedBlocksPropertyKey,
  typedBlocksReferenceFieldKey,
  typedBlocksReferenceKey,
  typedBlocksTypeKey,
} from '@/data/invalidation'

const WS = 'ws-1'

interface SidePatch {
  parentId?: string | null
  workspaceId?: string
  deleted?: boolean
  content?: string
  references?: ReadonlyArray<{ id: string; sourceField?: string }>
  properties?: Readonly<Record<string, unknown>>
}

const side = (patch: SidePatch | null = {}): ChangeSnapshot['after'] => {
  if (patch === null) return null
  return {
    parentId: patch.parentId ?? null,
    workspaceId: patch.workspaceId ?? WS,
    deleted: patch.deleted,
    content: patch.content,
    references: patch.references,
    properties: patch.properties,
  }
}

const collect = (snapshot: ChangeSnapshot): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  emitKernelInvalidations(snapshot, (channel, key) => {
    out.push([channel, key])
  })
  return out
}

describe('emitKernelInvalidations — typedBlocks channels', () => {
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
      // Content ref (no sourceField) still gets a field channel keyed
      // by `''` so `referencedBy: {id, sourceField: ''}` queries match.
      [TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(WS, 't2', '')],
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
      [TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(WS, 't1', '')],
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
    expect(out.filter(([, key]) => key === typedBlocksTypeKey(WS, 'note'))).toEqual([])
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
      // t3 is a content ref (no sourceField) — emits the field channel
      // keyed by `''`, matching `referencedBy: {id, sourceField: ''}`.
      [TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(WS, 't3', '')],
    ]))
    expect(out.filter(([, key]) => key === typedBlocksReferenceKey(WS, 't1'))).toEqual([])
  })

  it('emits the empty-string field channel for content refs (sourceField omitted)', () => {
    // Content refs are stored in `block_references.source_field` as
    // `''`; queries with `referencedBy: {id, sourceField: ''}` mean
    // "content refs only". Skipping the empty-field emit would silently
    // drop those queries on the floor (the broad target channel
    // doesn't help — `kernelQueries.typedBlocks` narrows to the field
    // channel when `sourceField !== undefined`).
    const out = collect({
      before: side({ references: [] }),
      after: side({ references: [{ id: 't-content' }] }),
    })
    expect(out).toEqual(expect.arrayContaining([
      [TYPED_BLOCKS_REFERENCE_CHANNEL, typedBlocksReferenceKey(WS, 't-content')],
      [TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, typedBlocksReferenceFieldKey(WS, 't-content', '')],
    ]))
  })

  it('does not double-emit when the same target appears with multiple sourceFields', () => {
    const out = collect({
      before: side({ references: [] }),
      after: side({ references: [
        { id: 't1', sourceField: 'a' },
        { id: 't1', sourceField: 'b' },
      ] }),
    })
    const targetEmits = out.filter(([, key]) => key === typedBlocksReferenceKey(WS, 't1'))
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

describe('emitKernelInvalidations — kernel.aliases', () => {
  it('emits kernel.aliases when the alias property changes on a live row', () => {
    const out = collect({
      before: side({ properties: { alias: ['old'] } }),
      after: side({ properties: { alias: ['new'] } }),
    })
    expect(out).toContainEqual([KERNEL_ALIASES_CHANNEL, kernelAliasesKey(WS)])
  })

  it('does not emit kernel.aliases for non-alias property changes', () => {
    const out = collect({
      before: side({ properties: { status: 'open' } }),
      after: side({ properties: { status: 'done' } }),
    })
    expect(out.find(([ch]) => ch === KERNEL_ALIASES_CHANNEL)).toBeUndefined()
  })

  it('emits kernel.aliases on creation when the new row carries aliases', () => {
    const out = collect({
      before: null,
      after: side({ properties: { alias: ['my-page'] } }),
    })
    expect(out).toContainEqual([KERNEL_ALIASES_CHANNEL, kernelAliasesKey(WS)])
  })

  it('does NOT emit kernel.aliases on creation of a row with no aliases', () => {
    // block_aliases is keyed off `properties.alias`; a new row with no
    // alias entry doesn't shift the index, so an alias-keyed query
    // shouldn't wake.
    const out = collect({
      before: null,
      after: side({ properties: { types: ['note'] } }),
    })
    expect(out.find(([ch]) => ch === KERNEL_ALIASES_CHANNEL)).toBeUndefined()
  })

  it('emits kernel.aliases on tombstone of a row that carried aliases', () => {
    const out = collect({
      before: side({ properties: { alias: ['gone'] } }),
      after: side({ deleted: true, properties: { alias: ['gone'] } }),
    })
    expect(out).toContainEqual([KERNEL_ALIASES_CHANNEL, kernelAliasesKey(WS)])
  })

  it('does NOT emit kernel.aliases on tombstone of a row with no aliases', () => {
    const out = collect({
      before: side({ properties: { types: ['note'] } }),
      after: side({ deleted: true, properties: { types: ['note'] } }),
    })
    expect(out.find(([ch]) => ch === KERNEL_ALIASES_CHANNEL)).toBeUndefined()
  })

  it('emits kernel.aliases for an empty-string alias (mirrors block_aliases trigger)', () => {
    // The block_aliases trigger indexes any `text`-typed alias entry,
    // including `''` (`typeof(je.value) = 'text'` in clientSchema.ts).
    // An alias-keyed query subscribed to `kernel.aliases` must wake on
    // create/restore/tombstone of such a row, or the index update
    // silently slips past the handle.
    const out = collect({
      before: null,
      after: side({ properties: { alias: [''] } }),
    })
    expect(out).toContainEqual([KERNEL_ALIASES_CHANNEL, kernelAliasesKey(WS)])
  })
})

describe('emitKernelInvalidations — kernel.content', () => {
  it('emits kernel.content when content changes on a live row', () => {
    const out = collect({
      before: side({ content: 'old' }),
      after: side({ content: 'new' }),
    })
    expect(out).toContainEqual([KERNEL_CONTENT_CHANNEL, kernelContentKey(WS)])
  })

  it('does not emit kernel.content when content is unchanged', () => {
    const out = collect({
      before: side({ content: 'same', properties: { status: 'a' } }),
      after: side({ content: 'same', properties: { status: 'b' } }),
    })
    expect(out.find(([ch]) => ch === KERNEL_CONTENT_CHANNEL)).toBeUndefined()
  })

  it('emits kernel.content on row creation (membership change)', () => {
    const out = collect({
      before: null,
      after: side({ content: 'hi' }),
    })
    expect(out).toContainEqual([KERNEL_CONTENT_CHANNEL, kernelContentKey(WS)])
  })

  it('emits kernel.content on tombstone (membership change)', () => {
    const out = collect({
      before: side({ content: 'bye' }),
      after: side({ deleted: true, content: 'bye' }),
    })
    expect(out).toContainEqual([KERNEL_CONTENT_CHANNEL, kernelContentKey(WS)])
  })

  it('emits kernel.content on restore (deleted → live)', () => {
    const out = collect({
      before: side({ deleted: true, content: 'restored' }),
      after: side({ content: 'restored' }),
    })
    expect(out).toContainEqual([KERNEL_CONTENT_CHANNEL, kernelContentKey(WS)])
  })

  it('does not emit kernel.content for a property-only edit (UiState focus-location write shape)', () => {
    // The whole point of this channel: UiState writes (property bag
    // changes only, content unchanged) must not invalidate
    // searchByContent / recentBlocks.
    const out = collect({
      before: side({
        content: 'main',
        properties: { focusedBlockLocation: {blockId: 'a', renderScopeId: 'scope:a'} },
      }),
      after: side({
        content: 'main',
        properties: { focusedBlockLocation: {blockId: 'b', renderScopeId: 'scope:b'} },
      }),
    })
    expect(out.find(([ch]) => ch === KERNEL_CONTENT_CHANNEL)).toBeUndefined()
  })

  it('emits kernel.content exactly once even when both content and liveness change', () => {
    const out = collect({
      before: null,
      after: side({ content: 'fresh' }),
    })
    const contentEmits = out.filter(([ch]) => ch === KERNEL_CONTENT_CHANNEL)
    expect(contentEmits).toHaveLength(1)
  })
})
