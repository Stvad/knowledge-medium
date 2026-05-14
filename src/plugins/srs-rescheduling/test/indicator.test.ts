import { describe, expect, it } from 'vitest'
import { srsBarClass, srsIndicatorTitle, type SrsIndicatorState } from '../indicator.ts'

const state = (overrides: Partial<SrsIndicatorState> = {}): SrsIndicatorState => ({
  interval: 2,
  reviewCount: 0,
  archived: false,
  ...overrides,
})

describe('srsBarClass', () => {
  it('uses a dashed muted bar for archived blocks regardless of interval', () => {
    expect(srsBarClass(state({archived: true, interval: 60, reviewCount: 12})))
      .toContain('border-muted-foreground/30')
    expect(srsBarClass(state({archived: true}))).toContain('border-dashed')
  })

  it('uses a dashed faint sky bar for unreviewed blocks', () => {
    const cls = srsBarClass(state({reviewCount: 0, interval: 2}))
    expect(cls).toContain('border-sky-500/40')
    expect(cls).toContain('border-dashed')
  })

  it('ramps opacity down as interval grows', () => {
    expect(srsBarClass(state({reviewCount: 1, interval: 1}))).toMatch(/border-sky-500(?!\/)/)
    expect(srsBarClass(state({reviewCount: 1, interval: 3}))).toMatch(/border-sky-500(?!\/)/)
    expect(srsBarClass(state({reviewCount: 1, interval: 4}))).toContain('border-sky-500/75')
    expect(srsBarClass(state({reviewCount: 1, interval: 10}))).toContain('border-sky-500/75')
    expect(srsBarClass(state({reviewCount: 1, interval: 11}))).toContain('border-sky-500/50')
    expect(srsBarClass(state({reviewCount: 1, interval: 30}))).toContain('border-sky-500/50')
    expect(srsBarClass(state({reviewCount: 1, interval: 31}))).toContain('border-sky-500/30')
    expect(srsBarClass(state({reviewCount: 1, interval: 90}))).toContain('border-sky-500/30')
    expect(srsBarClass(state({reviewCount: 1, interval: 91}))).toContain('border-sky-500/15')
    expect(srsBarClass(state({reviewCount: 1, interval: 365}))).toContain('border-sky-500/15')
  })

  it('keeps a small left gap so text does not touch the bar', () => {
    expect(srsBarClass(state({reviewCount: 1, interval: 7}))).toContain('pl-1')
  })

  it('archived takes precedence over unreviewed', () => {
    const cls = srsBarClass(state({archived: true, reviewCount: 0}))
    expect(cls).toContain('border-muted-foreground/30')
    expect(cls).not.toContain('border-sky-500')
  })
})

describe('srsIndicatorTitle', () => {
  it('flags archived state', () => {
    expect(srsIndicatorTitle(state({archived: true, interval: 90, reviewCount: 10})))
      .toBe('SRS · archived')
  })

  it('flags unreviewed state', () => {
    expect(srsIndicatorTitle(state({reviewCount: 0})))
      .toBe('SRS · new (not yet reviewed)')
  })

  it('rounds fractional intervals to one decimal place', () => {
    expect(srsIndicatorTitle(state({reviewCount: 1, interval: 4.830283949637418})))
      .toBe('SRS · 4.8d interval · 1 review')
  })

  it('drops trailing zero for whole-day intervals', () => {
    expect(srsIndicatorTitle(state({reviewCount: 3, interval: 7})))
      .toBe('SRS · 7d interval · 3 reviews')
  })

  it('shows interval and singular vs plural review count', () => {
    expect(srsIndicatorTitle(state({reviewCount: 1, interval: 4})))
      .toBe('SRS · 4d interval · 1 review')
    expect(srsIndicatorTitle(state({reviewCount: 7, interval: 45})))
      .toBe('SRS · 45d interval · 7 reviews')
  })
})
