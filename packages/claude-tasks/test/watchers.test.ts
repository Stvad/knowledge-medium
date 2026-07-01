import {describe, expect, it} from 'vitest'
import {
  decidePending,
  diffQueryRows,
  findThreadSession,
  STALE_RUNNING_MS,
  type BlockView,
} from '../src/watchers'
import {PROPS} from '../src/config'

const NOW = 1_800_000_000_000

const block = (overrides: Partial<BlockView> = {}): BlockView => ({
  id: 'block-1',
  content: '[[claude]] do the thing',
  properties: {},
  ...overrides,
})

describe('decidePending', () => {
  it('marks an unseen mention block as pending', () => {
    expect(decidePending({source: block(), ancestors: [], nowMs: NOW}))
      .toEqual({pending: true, reason: 'pending'})
  })

  it.each(['queued', 'done', 'error'] as const)('skips blocks already claimed with status=%s', status => {
    const source = block({properties: {[PROPS.status]: status}})
    expect(decidePending({source, ancestors: [], nowMs: NOW}).pending).toBe(false)
  })

  it('skips a fresh running block but re-queues a stale one (crashed run)', () => {
    const fresh = block({properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - 1_000}})
    expect(decidePending({source: fresh, ancestors: [], nowMs: NOW}).pending).toBe(false)

    const stale = block({properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - STALE_RUNNING_MS}})
    expect(decidePending({source: stale, ancestors: [], nowMs: NOW}))
      .toEqual({pending: true, reason: 'stale-running'})
  })

  it('treats running with NO timestamp as stale (legacy/corrupt marker)', () => {
    const source = block({properties: {[PROPS.status]: 'running'}})
    expect(decidePending({source, ancestors: [], nowMs: NOW}).pending).toBe(true)
  })

  it('never triggers on daemon-authored replies or blocks inside them', () => {
    const reply = block({properties: {[PROPS.reply]: true}})
    expect(decidePending({source: reply, ancestors: [], nowMs: NOW}).reason).toBe('is-reply')

    const child = block()
    const replyAncestor = block({id: 'reply-parent', properties: {[PROPS.reply]: true}})
    expect(decidePending({source: child, ancestors: [replyAncestor], nowMs: NOW}).reason)
      .toBe('inside-reply')
  })

  it('ignores foreign statuses (does not choke on user-set values)', () => {
    const source = block({properties: {[PROPS.status]: 'weird-user-value'}})
    expect(decidePending({source, ancestors: [], nowMs: NOW}).pending).toBe(true)
  })
})

describe('findThreadSession', () => {
  it('prefers the source block session, then the nearest ancestor', () => {
    const source = block({properties: {[PROPS.session]: 'sess-self'}})
    const near = block({id: 'a', properties: {[PROPS.session]: 'sess-near'}})
    const far = block({id: 'b', properties: {[PROPS.session]: 'sess-far'}})

    expect(findThreadSession(source, [near, far])).toBe('sess-self')
    expect(findThreadSession(block(), [near, far])).toBe('sess-near')
    expect(findThreadSession(block(), [])).toBeNull()
  })

  it('ignores empty/non-string session values', () => {
    const source = block({properties: {[PROPS.session]: ''}})
    const ancestor = block({id: 'a', properties: {[PROPS.session]: 42}})
    expect(findThreadSession(source, [ancestor])).toBeNull()
  })
})

describe('diffQueryRows', () => {
  it('establishes a baseline on first run without firing', () => {
    const diff = diffQueryRows([{id: 'a'}, {id: 'b'}], null)
    expect(diff.newRows).toEqual([])
    expect(diff.seenIds).toEqual(['a', 'b'])
  })

  it('fires only for ids not previously seen', () => {
    const diff = diffQueryRows([{id: 'a'}, {id: 'c', extra: 1}], ['a', 'b'])
    expect(diff.newRows).toEqual([{id: 'c', extra: 1}])
    expect(diff.seenIds).toEqual(['a', 'c'])
  })

  it('counts and skips rows without a stable id', () => {
    const diff = diffQueryRows([{id: 'a'}, {name: 'no-id'}, 42], [])
    expect(diff.newRows).toEqual([{id: 'a'}])
    expect(diff.invalidRows).toBe(2)
  })
})
