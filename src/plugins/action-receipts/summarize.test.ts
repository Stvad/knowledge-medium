import { describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { UndoEntry } from '@/data/internals/undoManager'
import { newSnapshotsMap } from '@/data/internals/txSnapshots'
import { makeBlockData } from '@/data/test/factories'
import { aliasesProp } from '@/data/properties'
import { locationOf, subjectOf } from './facet.ts'
import { classifyRow, contentPeek, phrase, propertyDisplayName, summarizeEntry } from './summarize.ts'

const WS = 'ws-1'
const block = (id: string, overrides: Partial<ReturnType<typeof makeBlockData>> = {}) =>
  makeBlockData({id, workspaceId: WS, ...overrides})

const entryOf = (rows: Array<[string, ReturnType<typeof block> | null, ReturnType<typeof block> | null]>): UndoEntry => {
  const snapshots = newSnapshotsMap()
  for (const [id, before, after] of rows) snapshots.set(id, {before, after})
  return {scope: ChangeScope.BlockDefault, txId: 'tx', snapshots}
}

describe('classifyRow', () => {
  it('names each kind of change and drops a no-op touch', () => {
    const a = block('a', {content: 'x'})
    expect(classifyRow('a', null, a)?.kind).toBe('create')
    expect(classifyRow('a', a, {...a, deleted: true})?.kind).toBe('delete')
    expect(classifyRow('a', {...a, deleted: true}, a)?.kind).toBe('create')
    expect(classifyRow('a', a, {...a, parentId: 'p'})?.kind).toBe('move')
    expect(classifyRow('a', a, {...a, orderKey: 'a1'})?.kind).toBe('move')
    expect(classifyRow('a', a, {...a, content: 'y'})?.kind).toBe('content')
    expect(classifyRow('a', a, {...a, properties: {status: 'done'}})?.kind).toBe('properties')
    expect(classifyRow('a', a, {...a})).toBeNull()
    expect(classifyRow('a', a, null)?.kind).toBe('delete')
  })
})

describe('contentPeek', () => {
  it('splits shared prefix and suffix from the differing middles', () => {
    expect(contentPeek('Ship the sidenote rail by Friday', 'Ship the sidenote rail')).toEqual({
      prefix: 'Ship the sidenote rail',
      suffix: '',
      beforeSegment: ' by Friday',
      afterSegment: '',
    })
    expect(contentPeek('quaterly', 'quarterly')).toEqual({
      prefix: 'qua', suffix: 'terly', beforeSegment: '', afterSegment: 'r',
    })
  })

  it('clips long shared text around the change', () => {
    const long = 'a'.repeat(60)
    const peek = contentPeek(`${long}X${long}`, `${long}Y${long}`)
    expect(peek.prefix).toBe(`…${'a'.repeat(24)}`)
    expect(peek.suffix).toBe(`${'a'.repeat(24)}…`)
    expect(peek.beforeSegment).toBe('X')
    expect(peek.afterSegment).toBe('Y')
  })
})

describe('summarizeEntry', () => {
  it('names the edited block and carries the peek', () => {
    const before = block('a', {content: 'Ship the sidenote rail by Friday'})
    const summary = summarizeEntry(entryOf([['a', before, {...before, content: 'Ship the sidenote rail'}]]))
    expect(summary.subject).toMatchObject({id: 'a', kind: 'content', label: 'Ship the sidenote rail'})
    expect(summary.others).toBe(0)
    expect(summary.peek?.beforeSegment).toBe(' by Friday')
    // Undoing that edit puts " by Friday" back: it is what the gesture added.
    expect(phrase(summary, 'undo')).toMatchObject({verb: 'Undid edit', riders: '', peek: {gone: '', now: ' by Friday'}})
    expect(phrase(summary, 'forward').peek).toMatchObject({gone: ' by Friday', now: ''})
  })

  it('names the top of a deleted subtree and counts its children', () => {
    const root = block('root', {content: 'Perf baseline'})
    const kids = ['k1', 'k2', 'k3'].map(id => block(id, {parentId: 'root'}))
    const grandkid = block('g1', {parentId: 'k1'})
    const rows = [root, ...kids, grandkid].map(b =>
      [b.id, b, {...b, deleted: true}] as [string, typeof b, typeof b])
    // Map order is insertion order; put the root last so the choice is not
    // "first row wins".
    const summary = summarizeEntry(entryOf([...rows.slice(1), rows[0]]))
    expect(summary.subject).toMatchObject({id: 'root', kind: 'delete', label: 'Perf baseline'})
    expect(summary.others).toBe(4)
    expect(phrase(summary, 'undo')).toMatchObject({verb: 'Restored', riders: 'and 4 children'})
    expect(phrase(summary, 'forward')).toMatchObject({verb: 'Deleted', riders: 'and 4 children'})
    expect(phrase(summary, 'redo').verb).toBe('Deleted again')
    // The gesture that deletes leaves nothing to go to; the one that restores does.
    expect(subjectOf(summary, 'forward')?.navigable).toBe(false)
    expect(subjectOf(summary, 'undo')?.navigable).toBe(true)
  })

  it('prefers the row the user changed over the rows a helper minted', () => {
    // A reschedule: daily note + journal block created, one property written
    // on the card.
    const card = block('card', {content: 'What is a monad?', properties: {'srs:next': '2026-09-24'}})
    const summary = summarizeEntry(entryOf([
      ['note', null, block('note', {content: '2026-09-24'})],
      ['journal', null, block('journal', {parentId: 'note'})],
      ['card', {...card, properties: {'srs:next': '2026-09-17'}}, card],
    ]))
    expect(summary.subject).toMatchObject({id: 'card', kind: 'properties'})
    expect(summary.changedProperties).toEqual(['srs:next'])
    // The daily note and its journal block are not under the card.
    expect(summary.others).toBe(0)
    expect(phrase(summary, 'undo')).toMatchObject({verb: 'Undid next change', riders: ''})
  })

  it('names the moved block when the move also revealed a collapsed destination', () => {
    const dest = block('dest', {content: 'Destination', properties: {collapsed: true}})
    const moved = block('x', {parentId: 'old', content: 'Moved block'})
    const summary = summarizeEntry(entryOf([
      ['x', moved, {...moved, parentId: 'dest', orderKey: 'zz'}],
      ['dest', dest, {...dest, properties: {collapsed: false}}],
    ]))
    expect(summary.subject).toMatchObject({id: 'x', kind: 'move', parentAfter: 'dest'})
    expect(summary.others).toBe(0)
    expect(phrase(summary, 'undo').verb).toBe('Moved back')
    expect(phrase(summary, 'forward').verb).toBe('Moved')
  })

  it('counts only the rows under the subject as riders', () => {
    // A paste of a root with two children, plus an unrelated edit in the
    // same entry: the children ride, the edit does not.
    const root = block('r', {content: 'Pasted'})
    const summary = summarizeEntry(entryOf([
      ['r', null, root],
      ['c1', null, block('c1', {parentId: 'r'})],
      ['c2', null, block('c2', {parentId: 'c1'})],
      ['e', block('e', {content: 'a'}), block('e', {content: 'b'})],
    ]))
    // The edited row wins the subject by priority; the paste root is not under it.
    expect(summary.subject).toMatchObject({id: 'e', kind: 'content'})
    expect(summary.others).toBe(0)
  })

  it('reports a move with both parents', () => {
    const before = block('b', {parentId: 'old', content: 'Book covers'})
    const summary = summarizeEntry(entryOf([['b', before, {...before, parentId: 'new', orderKey: 'z'}]]))
    expect(summary.subject).toMatchObject({kind: 'move', parentBefore: 'old', parentAfter: 'new'})
    expect(locationOf(summary, 'forward')).toEqual({id: 'new', workspaceId: WS})
    expect(locationOf(summary, 'undo')).toEqual({id: 'old', workspaceId: WS})
    expect(phrase(summary, 'undo').verb).toBe('Moved back')
  })

  it('labels a subject by alias before content', () => {
    const before = block('p', {content: 'body', properties: {[aliasesProp.name]: ['Marginalia design']}})
    const summary = summarizeEntry(entryOf([['p', before, {...before, content: 'body 2'}]]))
    expect(summary.subject?.label).toBe('Marginalia design')
  })

  it('has no subject when only property field rows changed', () => {
    const field = block('f', {parentId: 'p', isFieldForm: true, content: ':: x'})
    const summary = summarizeEntry(entryOf([['f', field, {...field, content: ':: y'}]]))
    expect(summary.subject).toBeNull()
    expect(subjectOf(summary, 'undo')).toBeUndefined()
    expect(phrase(summary, 'undo').verb).toBe('Undid change')
  })

  it('undoing a create removes the block, so nothing is navigable', () => {
    const summary = summarizeEntry(entryOf([['n', null, block('n', {content: 'new'})]]))
    expect(phrase(summary, 'undo').verb).toBe('Removed')
    expect(phrase(summary, 'redo').verb).toBe('Restored')
    expect(subjectOf(summary, 'undo')?.navigable).toBe(false)
    expect(subjectOf(summary, 'redo')?.navigable).toBe(true)
  })
})

describe('propertyDisplayName', () => {
  it('drops the namespace and the separators', () => {
    expect(propertyDisplayName('agenda:scheduled')).toBe('scheduled')
    expect(propertyDisplayName('weave:cover_img')).toBe('cover img')
    expect(propertyDisplayName('status')).toBe('status')
  })
})
