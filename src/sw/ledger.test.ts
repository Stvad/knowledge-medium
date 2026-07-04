import {describe, expect, it} from 'vitest'
import {computeExpiredIds, computeKeepIds, computeReapableCaches, normalizeLedger} from './ledger'

describe('generation ledger retention', () => {
  it('keeps the most recent `keep` ids and expires the older ones (disjoint partition)', () => {
    const ledger = ['a', 'b', 'c', 'd', 'e']
    expect(computeKeepIds(ledger, 3)).toEqual(['c', 'd', 'e'])
    expect(computeExpiredIds(ledger, 3)).toEqual(['a', 'b'])
  })

  it('keeps everything and expires nothing when the ledger fits the window', () => {
    const ledger = ['a', 'b']
    expect(computeKeepIds(ledger, 3)).toEqual(['a', 'b'])
    expect(computeExpiredIds(ledger, 3)).toEqual([])
  })

  it('always keeps the current (last-installed) id, never expires it', () => {
    const ledger = ['old1', 'old2', 'old3', 'current']
    expect(computeExpiredIds(ledger, 3)).not.toContain('current')
    expect(computeKeepIds(ledger, 3)).toContain('current')
  })
})

describe('normalizeLedger', () => {
  it('reads a legacy bare array as ids with no timestamp', () => {
    expect(normalizeLedger(['a', 'b'])).toEqual({ids: ['a', 'b'], updatedAt: undefined})
  })

  it('reads the timestamped {ids, updatedAt} shape', () => {
    expect(normalizeLedger({ids: ['a'], updatedAt: 123})).toEqual({ids: ['a'], updatedAt: 123})
  })

  it('treats a missing or non-numeric updatedAt as undefined', () => {
    expect(normalizeLedger({ids: ['a']})).toEqual({ids: ['a'], updatedAt: undefined})
    expect(normalizeLedger({ids: ['a'], updatedAt: 'soon'})).toEqual({ids: ['a'], updatedAt: undefined})
  })

  it('falls back to an empty ledger for null / garbage / a non-array ids', () => {
    expect(normalizeLedger(null)).toEqual({ids: [], updatedAt: undefined})
    expect(normalizeLedger(42)).toEqual({ids: [], updatedAt: undefined})
    expect(normalizeLedger({ids: 'nope'})).toEqual({ids: [], updatedAt: undefined})
  })
})

describe('computeReapableCaches (preview-only cache sweeper)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const STALE_MS = 14 * DAY
  const NOW = 1_700_000_000_000
  const PREFIX = 'km-'
  const prod = 'https://stvad.github.io/knowledge-medium/__km_generations__'
  const preview = (n: number) =>
    `https://stvad.github.io/knowledge-medium/pr-preview/pr-${n}/__km_generations__`
  const reap = (ledgers: Parameters<typeof computeReapableCaches>[0]['ledgers']) =>
    computeReapableCaches({ledgers, now: NOW, staleMs: STALE_MS, cachePrefix: PREFIX})

  it('reaps a stale preview scope: its generation caches AND its ledger entry', () => {
    const plan = reap([
      {scopeUrl: prod, ids: ['prod1', 'prod2'], updatedAt: NOW - DAY},
      {scopeUrl: preview(309), ids: ['pv1', 'pv2'], updatedAt: NOW - 15 * DAY},
    ])
    expect(plan.cacheNames.sort()).toEqual(
      ['km-assets-pv1', 'km-assets-pv2', 'km-shell-pv1', 'km-shell-pv2'].sort(),
    )
    expect(plan.ledgerScopeUrls).toEqual([preview(309)])
  })

  it('keeps a FRESH preview scope (touched within the window)', () => {
    const plan = reap([{scopeUrl: preview(310), ids: ['pv3'], updatedAt: NOW - 3 * DAY}])
    expect(plan).toEqual({cacheNames: [], ledgerScopeUrls: []})
  })

  it('NEVER reaps the production scope, even if ancient', () => {
    const plan = reap([{scopeUrl: prod, ids: ['prod1'], updatedAt: NOW - 999 * DAY}])
    expect(plan).toEqual({cacheNames: [], ledgerScopeUrls: []})
  })

  it('does not reap a legacy (untimestamped) preview ledger — staleness is unprovable', () => {
    const plan = reap([{scopeUrl: preview(311), ids: ['pv4'], updatedAt: undefined}])
    expect(plan).toEqual({cacheNames: [], ledgerScopeUrls: []})
  })

  it('shared-sha protection: a cache a KEPT ledger still references is not deleted', () => {
    // A stale preview shares a build sha with production; its own unique
    // generation is reaped, the shared one is spared, but the stale ledger
    // entry is still removed.
    const plan = reap([
      {scopeUrl: prod, ids: ['shared', 'prod2'], updatedAt: NOW - DAY},
      {scopeUrl: preview(312), ids: ['shared', 'pvOnly'], updatedAt: NOW - 30 * DAY},
    ])
    expect(plan.cacheNames.sort()).toEqual(['km-assets-pvOnly', 'km-shell-pvOnly'].sort())
    expect(plan.cacheNames).not.toContain('km-shell-shared')
    expect(plan.ledgerScopeUrls).toEqual([preview(312)])
  })

  it('never reaps the sweeping SW’s OWN scope, even if its ledger looks stale', () => {
    const self = preview(313)
    const plan = computeReapableCaches({
      ledgers: [{scopeUrl: self, ids: ['selfId'], updatedAt: NOW - 99 * DAY}],
      now: NOW,
      staleMs: STALE_MS,
      cachePrefix: PREFIX,
      selfScopeUrl: self,
    })
    expect(plan).toEqual({cacheNames: [], ledgerScopeUrls: []})
  })

  it('reaps multiple stale previews together', () => {
    const plan = reap([
      {scopeUrl: preview(1), ids: ['a'], updatedAt: NOW - 20 * DAY},
      {scopeUrl: preview(2), ids: ['b'], updatedAt: NOW - 20 * DAY},
    ])
    expect(plan.cacheNames.sort()).toEqual(
      ['km-assets-a', 'km-assets-b', 'km-shell-a', 'km-shell-b'].sort(),
    )
    expect(plan.ledgerScopeUrls.sort()).toEqual([preview(1), preview(2)].sort())
  })
})
