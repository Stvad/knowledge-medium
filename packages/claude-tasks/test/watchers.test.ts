import {describe, expect, it} from 'vitest'
import {
  decidePending,
  diffQueryRows,
  findThreadSession,
  MAX_ATTEMPTS,
  MAX_CURSOR_IDS,
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
    expect(decidePending({source: block(), nowMs: NOW}))
      .toEqual({pending: true, reason: 'pending'})
  })

  it.each(['queued', 'done', 'error'] as const)('skips blocks already claimed with status=%s', status => {
    const source = block({properties: {[PROPS.status]: status}})
    expect(decidePending({source, nowMs: NOW}).pending).toBe(false)
  })

  it('skips a fresh running block but re-queues a stale one (crashed run)', () => {
    const fresh = block({properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - 1_000}})
    expect(decidePending({source: fresh, nowMs: NOW}).pending).toBe(false)

    const stale = block({properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - STALE_RUNNING_MS}})
    expect(decidePending({source: stale, nowMs: NOW}))
      .toEqual({pending: true, reason: 'stale-running'})
  })

  it('treats running with NO timestamp as stale (legacy/corrupt marker)', () => {
    const source = block({properties: {[PROPS.status]: 'running'}})
    expect(decidePending({source, nowMs: NOW}).pending).toBe(true)
  })

  it('parks stale-running blocks once attempts are exhausted (caps the requeue/bill loop)', () => {
    const source = block({properties: {
      [PROPS.status]: 'running',
      [PROPS.updatedAt]: NOW - STALE_RUNNING_MS,
      [PROPS.attempts]: MAX_ATTEMPTS,
    }})
    expect(decidePending({source, nowMs: NOW}))
      .toEqual({pending: false, reason: 'attempts-exhausted'})
  })

  it('never triggers on daemon-authored replies, but DOES fire for user follow-ups nested under one', () => {
    const reply = block({properties: {[PROPS.reply]: true}})
    expect(decidePending({source: reply, nowMs: NOW}).reason).toBe('is-reply')

    // A mention typed under Claude's reply is a user-authored follow-up;
    // the old blanket "inside-reply" ban blocked the most natural thread
    // placement.
    const followUp = block({id: 'follow-up', parentId: 'reply-1'})
    expect(decidePending({source: followUp, nowMs: NOW}).pending).toBe(true)
  })

  it('waits out the quiet period so half-typed requests are not claimed', () => {
    const typing = block({editedAtMs: NOW - 3_000})
    expect(decidePending({source: typing, nowMs: NOW, quietMs: 15_000}))
      .toEqual({pending: false, reason: 'still-typing'})

    const settled = block({editedAtMs: NOW - 16_000})
    expect(decidePending({source: settled, nowMs: NOW, quietMs: 15_000}).pending).toBe(true)

    // No edit timestamp available → don't block on it.
    expect(decidePending({source: block(), nowMs: NOW, quietMs: 15_000}).pending).toBe(true)
  })

  it('ignores foreign statuses (does not choke on user-set values)', () => {
    const source = block({properties: {[PROPS.status]: 'weird-user-value'}})
    expect(decidePending({source, nowMs: NOW}).pending).toBe(true)
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
    expect(diff.seenIds).toEqual(['a', 'b', 'c'])
  })

  it('keeps the cursor a UNION: rows rotating out of a LIMIT window are not re-fired on re-entry', () => {
    // 'a' leaves the result set (e.g. LIMIT window rotation)…
    const rotatedOut = diffQueryRows([{id: 'b'}, {id: 'c'}], ['a', 'b'])
    expect(rotatedOut.newRows).toEqual([{id: 'c'}])
    expect(rotatedOut.seenIds).toContain('a')

    // …and re-enters later: must NOT fire (and bill) again.
    const rotatedBack = diffQueryRows([{id: 'a'}, {id: 'b'}], rotatedOut.seenIds)
    expect(rotatedBack.newRows).toEqual([])
  })

  it('bounds the cursor, forgetting oldest ids first', () => {
    const prev = Array.from({length: MAX_CURSOR_IDS}, (_, index) => `old-${index}`)
    const diff = diffQueryRows([{id: 'brand-new'}], prev)
    expect(diff.seenIds).toHaveLength(MAX_CURSOR_IDS)
    expect(diff.seenIds.at(-1)).toBe('brand-new')
    expect(diff.seenIds).not.toContain('old-0')
  })

  it('counts and skips rows without a stable id', () => {
    const diff = diffQueryRows([{id: 'a'}, {name: 'no-id'}, 42], [])
    expect(diff.newRows).toEqual([{id: 'a'}])
    expect(diff.invalidRows).toBe(2)
  })
})
