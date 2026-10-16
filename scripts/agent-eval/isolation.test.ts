import { describe, expect, it } from 'vitest'
import { type AllowedChanges, type AllowedEdit, type SnapshotRow, strayChanges } from './isolation'

const row = (id: string, overrides: Partial<SnapshotRow> = {}): SnapshotRow => ({
  id,
  parent_id: 'section',
  order_key: 'a0',
  content: 'Draft the pricing FAQ',
  properties_json: JSON.stringify({types: ['todo'], status: 'open', 'roam:uid': 'x'}),
  references_json: '[]',
  deleted: 0,
  updated_at: 1,
  user_updated_at: 1,
  ...overrides,
})

const allowing = (edit?: AllowedEdit, createRoots: string[] = []): AllowedChanges => ({
  edits: new Map(edit ? [['todo', edit]] : []),
  createRoots: new Set(createRoots),
})

/** Stray count of one change to the `todo` block. */
const strayOf = (after: Partial<SnapshotRow>, edit?: AllowedEdit) =>
  strayChanges({created: [], modified: [{id: 'todo', before: row('todo'), after: row('todo', after)}]}, allowing(edit))

const properties = (bag: Record<string, unknown>) => ({properties_json: JSON.stringify(bag)})

describe('strayChanges', () => {
  const statusOnly: AllowedEdit = {properties: ['status']}

  it('allows exactly the fields a task was asked to change', () => {
    expect(strayOf({content: 'Draft the FAQ'}, {content: true})).toBe(0)
    expect(strayOf(properties({types: ['todo'], status: 'done', 'roam:uid': 'x'}), statusOnly)).toBe(0)
    // Key order is not a change.
    expect(strayOf(properties({'roam:uid': 'x', status: 'done', types: ['todo']}), statusOnly)).toBe(0)
  })

  it('counts any other change to an allowed block', () => {
    expect(strayOf({content: 'Draft the FAQ'}, statusOnly)).toBe(1)
    expect(strayOf(properties({types: ['todo'], status: 'done', 'roam:uid': 'x', note: 'extra'}), statusOnly)).toBe(1)
    expect(strayOf(properties({types: ['todo'], status: 'done'}), statusOnly)).toBe(1)
    expect(strayOf(properties({types: ['todo'], status: 'open', 'roam:uid': 'x'}), {content: true})).toBe(0)
    expect(strayOf(properties({types: [], status: 'open', 'roam:uid': 'x'}), {content: true})).toBe(1)
    expect(strayOf({parent_id: 'elsewhere'}, statusOnly)).toBe(1)
    expect(strayOf({order_key: 'b0'}, statusOnly)).toBe(1)
    expect(strayOf({deleted: 1}, statusOnly)).toBe(1)
  })

  it('counts every change to a block the task was not asked to edit, but not what follows from one', () => {
    expect(strayOf({content: 'Draft the FAQ'})).toBe(1)
    // A derived column or a recency stamp moves because something upstream
    // was written; that write is what counts.
    expect(strayOf({references_json: '[{"id":"p"}]', updated_at: 2})).toBe(0)
  })

  it('allows creating under a root, at any depth, and ignores what was created and deleted again', () => {
    const created = [
      row('new', {parent_id: 'section'}),
      row('child', {parent_id: 'new'}),
      row('elsewhere', {parent_id: 'other'}),
      row('gone', {parent_id: 'other', deleted: 1}),
    ]
    expect(strayChanges({created, modified: []}, allowing(undefined, ['section']))).toBe(1)
    expect(strayChanges({created, modified: []}, allowing(undefined, []))).toBe(3)
  })
})
