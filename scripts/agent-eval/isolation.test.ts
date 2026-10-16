import { describe, expect, it } from 'vitest'
import type { GraphProbe } from './graphQueries'
import { type AllowedChanges, type AllowedEdit, type SnapshotRow, strayChanges, waitForQuiet } from './isolation'

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

const allowing = (edit?: AllowedEdit, creates: Record<string, Record<string, unknown>> = {}): AllowedChanges => ({
  edits: new Map(edit ? [['todo', edit]] : []),
  creates: new Map(Object.entries(creates)),
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

  it('allows exactly the blocks a task was asked to create, and ignores what was created and deleted again', () => {
    const plain = {properties_json: '{}'}
    const created = [
      row('new', {parent_id: 'section', ...plain}),
      row('child', {parent_id: 'new', ...plain}),
      row('beside', {parent_id: 'section', ...plain}),
      row('gone', {parent_id: 'section', deleted: 1, ...plain}),
    ]
    expect(strayChanges({created, modified: []}, allowing(undefined, {new: {}, child: {}}))).toBe(1)
    expect(strayChanges({created, modified: []}, allowing())).toBe(3)
  })

  it('counts a requested block whose properties are not exactly the ones it was asked for', () => {
    const page = (properties: Record<string, unknown>) => row('page', {parent_id: null, properties_json: JSON.stringify(properties)})
    const expected = {page: {types: ['page'], alias: ['Review']}}
    expect(strayChanges({created: [page({alias: ['Review'], types: ['page']})], modified: []}, allowing(undefined, expected))).toBe(0)
    expect(strayChanges({created: [page({types: ['page'], alias: ['Review'], note: 'x'})], modified: []}, allowing(undefined, expected))).toBe(1)
    expect(strayChanges({created: [page({types: ['page', 'todo'], alias: ['Review']})], modified: []}, allowing(undefined, expected))).toBe(1)
  })
})

describe('waitForQuiet', () => {
  /** A graph whose write fingerprint changes on every read while `busy`. */
  const graphThat = (busy: boolean): GraphProbe => {
    let writes = 0
    return {workspaceId: 'w', command: async () => [{rows: busy ? writes++ : 0}]}
  }

  it('returns once nothing has been written for the quiet period', async () => {
    await expect(waitForQuiet(graphThat(false), {quietMs: 30, maxMs: 500})).resolves.toBeUndefined()
  })

  it('throws, rather than reading a graph that never stops changing', async () => {
    await expect(waitForQuiet(graphThat(true), {quietMs: 30, maxMs: 200})).rejects.toThrow('still being written to after 0.2s')
  })
})
