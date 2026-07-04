import {describe, expect, it} from 'vitest'
import {computeExpiredIds, computeKeepIds} from './ledger'

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
