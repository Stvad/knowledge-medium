import {describe, expect, it} from 'vitest'
import {
  decidePending,
  diffQueryRows,
  findThreadSession,
  MAX_ATTEMPTS,
  MAX_CURSOR_IDS,
  OWNER_LEASE_MS,
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
  it('quietExempt bypasses the still-typing gate but not baseline or status', () => {
    const typing = block({editedAtMs: NOW - 1_000})
    expect(decidePending({source: typing, nowMs: NOW, quietMs: 5_000}).reason).toBe('still-typing')
    // Source-confirmed quiet (blur / explicit ask): claim immediately.
    expect(decidePending({source: typing, nowMs: NOW, quietMs: 5_000, quietExempt: true}).pending).toBe(true)

    // The exemption is ONLY about quiet — history and claimed state hold.
    const preBaseline = block({editedAtMs: NOW - 10_000})
    expect(decidePending({source: preBaseline, nowMs: NOW, baselineMs: NOW - 5_000, quietExempt: true}).reason)
      .toBe('pre-baseline')
    const claimed = block({properties: {[PROPS.status]: 'done'}, editedAtMs: NOW - 1_000})
    expect(decidePending({source: claimed, nowMs: NOW, quietMs: 5_000, quietExempt: true}).reason)
      .toBe('already-processed')
  })


  it('marks an unseen mention block as pending', () => {
    expect(decidePending({source: block(), nowMs: NOW}))
      .toEqual({pending: true, reason: 'pending'})
  })

  it.each(['done', 'error'] as const)('skips blocks already claimed with status=%s', status => {
    const source = block({properties: {[PROPS.status]: status}})
    expect(decidePending({source, nowMs: NOW}).pending).toBe(false)
  })

  describe('queued = deferred after a retryable infrastructure failure', () => {
    it('holds the task until agent:retry-after comes due, then re-fires it', () => {
      const waiting = block({properties: {[PROPS.status]: 'queued', [PROPS.retryAfter]: NOW + 30_000}})
      expect(decidePending({source: waiting, nowMs: NOW}))
        .toEqual({pending: false, reason: 'retry-waiting'})

      const due = block({properties: {[PROPS.status]: 'queued', [PROPS.retryAfter]: NOW}})
      expect(decidePending({source: due, nowMs: NOW}))
        .toEqual({pending: true, reason: 'retry-due'})
    })

    it('re-fires a queued task with no readable retry-after rather than stranding it', () => {
      // Nothing else moves a `queued` block, so "can't tell when" must mean
      // "now" — the opposite choice wedges the task forever.
      for (const retryAfter of [undefined, 0, 'soon', Number.NaN]) {
        const source = block({properties: {[PROPS.status]: 'queued', [PROPS.retryAfter]: retryAfter}})
        expect(decidePending({source, nowMs: NOW})).toEqual({pending: true, reason: 'retry-due'})
      }
    })

    it('ignores the quiet and baseline gates — the task was already claimed once', () => {
      const source = block({
        properties: {[PROPS.status]: 'queued', [PROPS.retryAfter]: NOW},
        editedAtMs: NOW - 1_000,
      })
      expect(decidePending({source, nowMs: NOW, quietMs: 60_000, baselineMs: NOW + 1_000}))
        .toEqual({pending: true, reason: 'retry-due'})
    })
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

  it('skips unclaimed blocks last edited before the watcher baseline (history is not a backlog)', () => {
    const old = block({editedAtMs: NOW - 60_000})
    expect(decidePending({source: old, nowMs: NOW, baselineMs: NOW - 30_000}))
      .toEqual({pending: false, reason: 'pre-baseline'})

    const edited = block({editedAtMs: NOW - 10_000})
    expect(decidePending({source: edited, nowMs: NOW, baselineMs: NOW - 30_000}).pending).toBe(true)
  })

  it('with a baseline set, an UNKNOWN edit time is treated as old (firing on "cannot tell" is the billed direction)', () => {
    expect(decidePending({source: block(), nowMs: NOW, baselineMs: NOW - 30_000}))
      .toEqual({pending: false, reason: 'pre-baseline'})
  })

  it('the baseline never gates claimed lifecycle: a stale running block still re-queues', () => {
    const stale = block({
      editedAtMs: NOW - STALE_RUNNING_MS * 2,
      properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - STALE_RUNNING_MS},
    })
    expect(decidePending({source: stale, nowMs: NOW, baselineMs: NOW}))
      .toEqual({pending: true, reason: 'stale-running'})
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
    // Cursor is a set; ordering is eviction priority (visible ids last).
    expect([...diff.seenIds].sort()).toEqual(['a', 'b', 'c'])
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

  it('never evicts currently-visible ids from the cursor (they would re-fire next poll)', () => {
    const prev = Array.from({length: MAX_CURSOR_IDS}, (_, index) => `old-${index}`)
    // Half the old ids still visible + an equal batch of new ids — the
    // total is exactly the cap, so this is NOT oversized, but a naive
    // append+slice would evict visible old ids from the front.
    const rows = [
      ...Array.from({length: MAX_CURSOR_IDS / 2}, (_, index) => ({id: `old-${index}`})),
      ...Array.from({length: MAX_CURSOR_IDS / 2}, (_, index) => ({id: `new-${index}`})),
    ]
    const diff = diffQueryRows(rows, prev)
    expect(diff.newRows).toHaveLength(MAX_CURSOR_IDS / 2)
    expect(diff.seenIds).toContain('old-0')
    // A re-poll of the identical result set must fire nothing.
    expect(diffQueryRows(rows, diff.seenIds).newRows).toEqual([])
  })

  it('refuses to diff an oversized result set instead of flapping the cursor window', () => {
    const rows = Array.from({length: MAX_CURSOR_IDS + 1}, (_, index) => ({id: `r-${index}`}))

    // First run: the full set can't be baselined — stay unbaselined, fire nothing.
    const first = diffQueryRows(rows, null)
    expect(first.oversized).toBe(true)
    expect(first.newRows).toEqual([])

    // Later runs: keep the existing cursor untouched, fire nothing —
    // a truncated-window diff would mark dropped ids "new" every tick.
    const later = diffQueryRows(rows, ['r-0'])
    expect(later.oversized).toBe(true)
    expect(later.newRows).toEqual([])
    expect(later.seenIds).toEqual(['r-0'])
  })

  it('counts and skips rows without a stable id', () => {
    const diff = diffQueryRows([{id: 'a'}, {name: 'no-id'}, 42], [])
    expect(diff.newRows).toEqual([{id: 'a'}])
    expect(diff.invalidRows).toBe(2)
  })
})

describe('a claimed task is its owner\'s, on a lease', () => {
  const NOW = 1_000_000
  const deferred = (owner: string, claimedAt: number) => ({
    id: 'b-1',
    properties: {
      [PROPS.status]: 'queued', [PROPS.retryAfter]: 0,
      [PROPS.watcher]: owner, [PROPS.updatedAt]: claimedAt,
    },
  })

  it('refuses a due deferral to a DIFFERENT watcher while the lease holds', () => {
    // Its prompt, its executor, its allowedTools. A task begun by a narrow
    // watcher must not resume under a broad one.
    expect(decidePending({
      source: deferred('claude-mentions', NOW - 60_000), nowMs: NOW,
      watcherName: 'codex-mentions',
    })).toMatchObject({pending: false, reason: 'other-watcher'})
  })

  it('still fires it for its own watcher, lease or not', () => {
    expect(decidePending({
      source: deferred('claude-mentions', NOW - 60_000), nowMs: NOW,
      watcherName: 'claude-mentions',
    })).toMatchObject({pending: true, reason: 'retry-due'})
  })

  it('releases it once the owner has had its chance and not taken it', () => {
    // Covers every reason an owner stops scanning a block — renamed,
    // deleted, or still named the same with a different target — without
    // having to tell them apart, which from here is not possible.
    expect(decidePending({
      source: deferred('retired-watcher', NOW - OWNER_LEASE_MS - 1), nowMs: NOW,
      watcherName: 'codex-mentions',
    })).toMatchObject({pending: true, reason: 'retry-due'})
  })

  it('releases one with no claim stamp rather than holding it for ever', () => {
    expect(decidePending({
      source: {id: 'b-1', properties: {
        [PROPS.status]: 'queued', [PROPS.retryAfter]: 0, [PROPS.watcher]: 'gone',
      }},
      nowMs: NOW, watcherName: 'codex-mentions',
    })).toMatchObject({pending: true, reason: 'retry-due'})
  })

  it('leaves an UNCLAIMED block racy, as designed', () => {
    expect(decidePending({
      source: {id: 'b-1', editedAtMs: NOW},
      nowMs: NOW, watcherName: 'codex-mentions',
    })).toMatchObject({pending: true})
  })
})
