// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  collectPluginInvalidationsFromSnapshots,
  type ChangeSnapshot,
  type InvalidationRowEvent,
} from '@/data/invalidation.ts'
import {
  BACKLINKS_TARGET_INVALIDATION_CHANNEL,
  backlinksInvalidationRule,
} from '../invalidation.ts'

const targetInvalidations = (
  snapshots: ReadonlyMap<string, ChangeSnapshot>,
): string[] =>
  Array.from(
    collectPluginInvalidationsFromSnapshots([backlinksInvalidationRule], snapshots)
      ?.get(BACKLINKS_TARGET_INVALIDATION_CHANNEL) ?? [],
  ).sort()

const collectFromRowEvent = (event: InvalidationRowEvent): string[] => {
  const out: string[] = []
  backlinksInvalidationRule.collectFromRowEvent?.(event, (channel, key) => {
    if (channel === BACKLINKS_TARGET_INVALIDATION_CHANNEL) out.push(key)
  })
  return out.sort()
}

describe('backlinks invalidation rule', () => {
  it('new live row contributes all target ids', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: null,
        after: {
          parentId: null,
          workspaceId: 'w',
          references: [{id: 'tgt-a'}, {id: 'tgt-b'}],
        },
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual(['tgt-a', 'tgt-b'])
  })

  it('soft-delete contributes all prior targets', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {
          parentId: null,
          workspaceId: 'w',
          deleted: false,
          references: [{id: 'tgt-x'}],
        },
        after: {
          parentId: null,
          workspaceId: 'w',
          deleted: true,
          references: [{id: 'tgt-x'}],
        },
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual(['tgt-x'])
  })

  it('tombstone restore contributes all current targets', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {
          parentId: null,
          workspaceId: 'w',
          deleted: true,
          references: [{id: 'tgt-x'}],
        },
        after: {
          parentId: null,
          workspaceId: 'w',
          deleted: false,
          references: [{id: 'tgt-x'}],
        },
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual(['tgt-x'])
  })

  it('added and removed refs contribute only the symmetric difference', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {
          parentId: null,
          workspaceId: 'w',
          references: [{id: 'kept'}, {id: 'removed'}],
        },
        after: {
          parentId: null,
          workspaceId: 'w',
          references: [{id: 'kept'}, {id: 'added'}],
        },
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual(['added', 'removed'])
  })

  it('pure content edit with unchanged references contributes nothing', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}]},
        after: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}]},
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual([])
  })

  it('alias-only change to the same target contributes nothing', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}]},
        after: {
          parentId: null,
          workspaceId: 'w',
          references: [{id: 'tgt'}, {id: 'tgt'}],
        },
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual([])
  })

  it('source-field-only changes invalidate the target for regrouping', () => {
    const snapshots = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {
          parentId: null,
          workspaceId: 'w',
          references: [{id: 'tgt', sourceField: 'reviewer'}],
        },
        after: {
          parentId: null,
          workspaceId: 'w',
          references: [{id: 'tgt', sourceField: 'blocked-by'}],
        },
      }],
    ])

    expect(targetInvalidations(snapshots)).toEqual(['tgt'])
  })

  it('row-event collector uses the same effective reference diff', () => {
    expect(collectFromRowEvent({
      blockId: 'src',
      kind: 'update',
      before: {
        id: 'src',
        workspaceId: 'w',
        parentId: null,
        orderKey: 'a0',
        content: '',
        properties: {},
        references: [{id: 'removed', alias: 'R'}, {id: 'kept', alias: 'K'}],
        createdAt: 0,
        updatedAt: 0,
        createdBy: 'u',
        updatedBy: 'u',
        deleted: false,
      },
      after: {
        id: 'src',
        workspaceId: 'w',
        parentId: null,
        orderKey: 'a0',
        content: '',
        properties: {},
        references: [{id: 'kept', alias: 'K'}, {id: 'added', alias: 'A'}],
        createdAt: 0,
        updatedAt: 0,
        createdBy: 'u',
        updatedBy: 'u',
        deleted: false,
      },
    })).toEqual(['added', 'removed'])
  })
})
