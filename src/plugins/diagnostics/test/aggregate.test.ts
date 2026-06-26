import { describe, expect, it } from 'vitest'
import { worstSeverity, type DiagnosticSourceContribution } from '../facet'
import { aggregateDiagnostics } from '../useDiagnostics'

const src = (id: string): DiagnosticSourceContribution => ({
  id,
  label: id,
  subscribe: () => () => {},
  getSnapshot: () => null,
})

describe('worstSeverity', () => {
  it('is ok for an empty set', () => {
    expect(worstSeverity([])).toBe('ok')
  })
  it('picks the highest-ranked severity', () => {
    expect(worstSeverity(['ok', 'warning', 'info'])).toBe('warning')
    expect(worstSeverity(['info', 'error', 'warning'])).toBe('error')
  })
})

describe('aggregateDiagnostics', () => {
  it('drops null snapshots and computes the worst severity', () => {
    const sources = [src('a'), src('b'), src('c')]
    const agg = aggregateDiagnostics(sources, [
      { severity: 'ok', summary: 'x' },
      null,
      { severity: 'error', summary: 'y' },
    ])
    expect(agg.items.map((i) => i.id)).toEqual(['a', 'c'])
    expect(agg.worst).toBe('error')
  })
  it('is ok when no source reports', () => {
    expect(aggregateDiagnostics([src('a')], [null]).worst).toBe('ok')
  })
})
