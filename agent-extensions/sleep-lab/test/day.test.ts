import {describe, expect, it} from 'vitest'

import {lastNightWakeDate, tonightWakeDate} from '../src/km/day'

const at = (day: string, hour: number): Date => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, 0, 0, 0)
}

describe('which night a gesture means', () => {
  it('in the evening, tonight ends tomorrow morning and last night ended this morning', () => {
    expect(tonightWakeDate(at('2026-09-07', 22))).toBe('2026-09-08')
    expect(lastNightWakeDate(at('2026-09-07', 22))).toBe('2026-09-07')
  })

  it('up late past midnight, tonight still ends today and last night ended yesterday', () => {
    expect(tonightWakeDate(at('2026-09-08', 1))).toBe('2026-09-08')
    expect(lastNightWakeDate(at('2026-09-08', 1))).toBe('2026-09-07')
  })

  it('in the morning, last night is the sleep that just ended and tonight is tomorrow', () => {
    expect(lastNightWakeDate(at('2026-09-08', 9))).toBe('2026-09-08')
    expect(tonightWakeDate(at('2026-09-08', 9))).toBe('2026-09-09')
  })
})
