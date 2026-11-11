// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { replayTarget } from './replayMerge'

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

  it('takes the far side whole when nothing touched the row since the entry', () => {
    const before = row({properties: {b: 1, a: 1}})
    const after = row({properties: {a: 2, b: 1}})
    expect(replayTarget(row({properties: {a: 2, b: 1}}), after, before)).toBe(before)
  })

  it('takes the far side whole when the entry created the row', () => {
    const created = row({content: 'born', properties: {a: 1}})
    expect(replayTarget(row({deleted: true, properties: {b: 2}}), null, created)).toBe(created)
  })
})
