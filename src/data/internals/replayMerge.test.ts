// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { replayConflicts, replayTarget } from './replayMerge'

const row = (patch: Partial<BlockData> = {}): BlockData => ({
  id: 'a',
  workspaceId: 'ws',
  parentId: 'p',
  orderKey: 'a0',
  content: 'text',
  referenceTargetId: null,
  isFieldForm: false,
  properties: {},
  references: [],
  createdAt: 1,
  updatedAt: 1,
  userUpdatedAt: 1,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
  ...patch,
})

describe('replayTarget', () => {
  it('restores the content the entry changed and keeps a property written since', () => {
    const before = row({content: 'old'})
    const after = row({content: 'new'})
    const current = row({content: 'new', properties: {status: 'done'}})

    const target = replayTarget(current, after, before)

    expect(target.content).toBe('old')
    expect(target.properties).toEqual({status: 'done'})
  })

  it('restores only the property keys the entry changed', () => {
    const before = row({properties: {a: 1, b: 1}})
    const after = row({properties: {a: 2, b: 1}})
    const current = row({properties: {a: 2, b: 5, c: 9}})

    expect(replayTarget(current, after, before).properties).toEqual({a: 1, b: 5, c: 9})
  })

  it('removes a key the entry added and puts back a key it removed', () => {
    const before = row({properties: {gone: 'x'}})
    const after = row({properties: {added: 'y'}})
    const current = row({properties: {added: 'y', other: 'z'}})

    expect(replayTarget(current, after, before).properties).toEqual({gone: 'x', other: 'z'})
  })

  it('keeps content written since when the entry changed only properties', () => {
    const before = row({content: 'c', properties: {a: 1}})
    const after = row({content: 'c', properties: {a: 2}})
    const current = row({content: 'typed since', properties: {a: 2}})

    const target = replayTarget(current, after, before)
    expect(target.content).toBe('typed since')
    expect(target.properties).toEqual({a: 1})
  })

  it('carries the derived content columns and content references with content', () => {
    const before = row({content: '::((t))', referenceTargetId: 't', isFieldForm: true, references: [{id: 't', alias: 't'}]})
    const after = row({content: 'plain'})
    const current = row({content: 'plain', references: [{id: 'r', alias: 'r', sourceField: 'link'}], properties: {link: 'r'}})

    const target = replayTarget(current, after, before)
    expect(target.referenceTargetId).toBe('t')
    expect(target.isFieldForm).toBe(true)
    expect(target.references).toEqual([
      {id: 't', alias: 't'},
      {id: 'r', alias: 'r', sourceField: 'link'},
    ])
  })

  it('restores a content reference\'s resolution that changed without the content', () => {
    const resolved = row({content: '[[t]]', referenceTargetId: 't'})
    expect(replayTarget({...resolved, properties: {a: 1}}, resolved, row({content: '[[t]]'})).referenceTargetId).toBeNull()

    const linked = row({content: '[[t]]', references: [{id: 't', alias: 't'}]})
    expect(replayTarget({...linked, properties: {a: 1}}, linked, row({content: '[[t]]'})).references).toEqual([])
  })

  it('restores a property key together with the references projected from it', () => {
    const before = row({properties: {link: 'x'}, references: [{id: 'x', alias: 'x', sourceField: 'link'}]})
    const after = row({properties: {link: 'y'}, references: [{id: 'y', alias: 'y', sourceField: 'link'}]})
    const current = row({
      content: 'see [[z]]',
      properties: {link: 'y'},
      references: [{id: 'z', alias: 'z'}, {id: 'y', alias: 'y', sourceField: 'link'}],
    })

    const target = replayTarget(current, after, before)
    expect(target.properties).toEqual({link: 'x'})
    expect(target.references).toEqual([
      {id: 'z', alias: 'z'},
      {id: 'x', alias: 'x', sourceField: 'link'},
    ])
  })

  it('keeps the merged references in canonical order', () => {
    const before = row({properties: {a: 'x'}, references: [{id: 'x', alias: 'x', sourceField: 'a'}]})
    const after = row({properties: {a: 'y'}, references: [{id: 'y', alias: 'y', sourceField: 'a'}]})
    const current = row({
      properties: {a: 'y', b: 'z'},
      references: [{id: 'y', alias: 'y', sourceField: 'a'}, {id: 'z', alias: 'z', sourceField: 'b'}],
    })

    expect(replayTarget(current, after, before).references).toEqual([
      {id: 'x', alias: 'x', sourceField: 'a'},
      {id: 'z', alias: 'z', sourceField: 'b'},
    ])
  })

  it('restores position as a pair and leaves it alone when the entry did not move the row', () => {
    const moved = replayTarget(
      row({parentId: 'q', orderKey: 'b0', content: 'typed since'}), row({parentId: 'q', orderKey: 'b0'}), row())
    expect([moved.parentId, moved.orderKey, moved.content]).toEqual(['p', 'a0', 'typed since'])

    const unmoved = replayTarget(row({parentId: 'q', orderKey: 'b0', content: 'x'}), row({content: 'x'}), row({content: 'y'}))
    expect([unmoved.parentId, unmoved.orderKey]).toEqual(['q', 'b0'])
  })

  it('restores the deleted flag the entry changed', () => {
    const target = replayTarget(row({deleted: true, content: 'typed since'}), row({deleted: true}), row())
    expect([target.deleted, target.content]).toEqual([false, 'typed since'])
  })

  it('keeps a delete made since when the entry only edited content', () => {
    const target = replayTarget(row({content: 'new', deleted: true}), row({content: 'new'}), row({content: 'old'}))
    expect([target.content, target.deleted]).toEqual(['old', true])
  })

  it('restores a key\'s references when only they changed', () => {
    const before = row({properties: {link: 'x'}, references: [{id: 'x', alias: 'x', sourceField: 'link'}]})
    const after = row({properties: {link: 'x'}})
    const current = row({content: 'typed since', properties: {link: 'x'}})

    expect(replayTarget(current, after, before).references).toEqual([{id: 'x', alias: 'x', sourceField: 'link'}])
  })

  it('restores the far side exactly, key order included, when nothing touched the row since the entry', () => {
    const before = row({properties: {b: 1, a: 1}})
    const after = row({properties: {a: 2, b: 1}})
    expect(Object.keys(replayTarget(row({properties: {a: 2, b: 1}}), after, before).properties)).toEqual(['b', 'a'])
  })

  it('redoes a create by reviving its tombstone, keeping what was written to it since', () => {
    const created = row({content: 'born', properties: {a: 1}})

    expect(replayTarget({...created, deleted: true}, null, created)).toEqual(created)
    expect(replayTarget({...created, deleted: true, properties: {a: 1, status: 'done'}}, null, created))
      .toEqual({...created, properties: {a: 1, status: 'done'}})
  })

  it('reads property keys as own keys only', () => {
    const before = row()
    const after = row({properties: {constructor: 'x'}})
    const target = replayTarget(row({properties: {constructor: 'x', other: 1}}), after, before)
    expect(target.properties).toEqual({other: 1})
  })
})

describe('replayConflicts', () => {
  it('is false when the write since touched only parts the entry did not change', () => {
    const before = row({content: 'old'})
    const after = row({content: 'new'})
    expect(replayConflicts(row({content: 'new', properties: {status: 'done'}}), after, before)).toBe(false)
  })

  it('is true when the write since touched a part the entry changed', () => {
    const before = row({properties: {alias: ['Old']}})
    const after = row({properties: {alias: ['Old', 'X']}})
    expect(replayConflicts(row({content: 'New', properties: {alias: ['New', 'X']}}), after, before)).toBe(true)
    expect(replayConflicts(row({content: 'typed since'}), row({content: 'new'}), row({content: 'old'}))).toBe(true)
    expect(replayConflicts(row({parentId: 'r'}), row({parentId: 'q'}), row())).toBe(true)
  })

  it('sees a created row\'s tombstone as the entry\'s side', () => {
    const created = row({content: 'born'})
    expect(replayConflicts({...created, deleted: true, properties: {status: 'done'}}, null, created)).toBe(false)
    expect(replayConflicts({...created, deleted: false}, null, created)).toBe(true)
  })
})
