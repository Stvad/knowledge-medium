// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { BlockData, ChangedRow } from '@/data/api'
import { addedTypes, removedTypes, typesProp } from '@/data/properties'

const blockData = (types: readonly string[]): BlockData => ({
  id: 'b1',
  workspaceId: 'ws-1',
  parentId: null,
  orderKey: 'b1',
  content: '',
  properties: {[typesProp.name]: typesProp.codec.encode(types)},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
})

const row = (
  before: readonly string[] | null,
  after: readonly string[] | null,
): ChangedRow => ({
  id: 'b1',
  before: before === null ? null : blockData(before),
  after: after === null ? null : blockData(after),
})

describe('addedTypes / removedTypes', () => {
  it('returns empty arrays for unchanged membership', () => {
    const r = row(['task', 'meeting'], ['task', 'meeting'])
    expect(addedTypes(r)).toEqual([])
    expect(removedTypes(r)).toEqual([])
  })

  it('detects added types', () => {
    const r = row(['task'], ['task', 'meeting'])
    expect(addedTypes(r)).toEqual(['meeting'])
    expect(removedTypes(r)).toEqual([])
  })

  it('detects removed types', () => {
    const r = row(['task', 'meeting'], ['task'])
    expect(addedTypes(r)).toEqual([])
    expect(removedTypes(r)).toEqual(['meeting'])
  })

  it('treats inserts (before=null) as all-added', () => {
    const r = row(null, ['task', 'meeting'])
    expect(addedTypes(r)).toEqual(['task', 'meeting'])
    expect(removedTypes(r)).toEqual([])
  })

  it('treats hard-deletes (after=null) as all-removed', () => {
    const r = row(['task', 'meeting'], null)
    expect(addedTypes(r)).toEqual([])
    expect(removedTypes(r)).toEqual(['task', 'meeting'])
  })

  it('returns empty arrays when both ends are null', () => {
    const r = row(null, null)
    expect(addedTypes(r)).toEqual([])
    expect(removedTypes(r)).toEqual([])
  })

  it('falls back to typesProp.defaultValue when properties lack the key', () => {
    const after: BlockData = {...blockData([]), properties: {}}
    const r: ChangedRow = {id: 'b1', before: blockData(['task']), after}
    expect(removedTypes(r)).toEqual(['task'])
    expect(addedTypes(r)).toEqual([])
  })
})
