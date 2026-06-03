// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  collectPluginInvalidationsFromSnapshots,
  type ChangeSnapshot,
} from '@/data/invalidation.js'
import {
  REFERENCES_TARGET_INVALIDATION_CHANNEL,
  referencesInvalidationRule,
} from '../invalidation.ts'

const targetInvalidations = (
  snapshots: ReadonlyMap<string, ChangeSnapshot>,
): string[] =>
  Array.from(
    collectPluginInvalidationsFromSnapshots([referencesInvalidationRule], snapshots)
      ?.get(REFERENCES_TARGET_INVALIDATION_CHANNEL) ?? [],
  ).sort()

describe('references invalidation rule', () => {
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
})
