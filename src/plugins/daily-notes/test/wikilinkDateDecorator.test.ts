// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { dailyDateWikilinkDecorator } from '../wikilinkDateDecorator.ts'

const ctx = (alias: string) => ({alias, blockId: 'b', workspaceId: 'ws'})

describe('dailyDateWikilinkDecorator', () => {
  it('prefixes weekday to Roam long-form aliases', () => {
    // 2026-04-26 is a Sunday.
    expect(dailyDateWikilinkDecorator.decorate(ctx('April 26th, 2026')))
      .toBe('Sun, April 26th, 2026')
  })

  it('prefixes weekday to ISO aliases', () => {
    expect(dailyDateWikilinkDecorator.decorate(ctx('2026-04-26')))
      .toBe('Sun, 2026-04-26')
  })

  it('returns null for non-date aliases', () => {
    expect(dailyDateWikilinkDecorator.decorate(ctx('My notes page'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx('today'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx('friday'))).toBeNull()
  })

  it('returns null for relative or fuzzy date expressions (not canonical)', () => {
    // parseLiteralDailyPageTitle rejects anything not in canonical form,
    // so a chrono-parseable but non-canonical alias like "April 26 2026"
    // should pass through undecorated rather than hijack the display.
    expect(dailyDateWikilinkDecorator.decorate(ctx('April 26 2026'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx('next week'))).toBeNull()
  })

  it('returns null for malformed dates that look ISO-shaped', () => {
    expect(dailyDateWikilinkDecorator.decorate(ctx('2026-13-01'))).toBeNull()
    expect(dailyDateWikilinkDecorator.decorate(ctx(''))).toBeNull()
  })
})
