import {describe, expect, it} from 'vitest'

import type {SetRecord} from '../src/engine/types'
import {lastTimeShape} from '../src/ui/summary'

const set = (weight: number, reps: number, side?: 'L' | 'R'): SetRecord =>
  ({weight, reps, ...(side ? {side} : {})})

describe('lastTimeShape', () => {
  it('uses the compact form when every set really did match', () => {
    expect(lastTimeShape([set(135, 10), set(135, 10), set(135, 10)], 3)).toBe('3×10')
  })

  it('spells out the reps when they differ', () => {
    // `3×10` is a claim about every set, and 10/8/7 is an ordinary session —
    // reported compactly it reads as a clean top-of-range performance, which
    // is the shape that says "add load", against a session that fatigued.
    expect(lastTimeShape([set(135, 10), set(135, 8), set(135, 7)], 3)).toBe('10/8/7')
  })

  it('counts a single-arm lift by its left side, not by its rows', () => {
    // Each prescribed set is stored as an L row and an R row, so counting
    // rows called a three-set lift six.
    expect(lastTimeShape([
      set(60, 10, 'L'), set(60, 10, 'R'),
      set(60, 10, 'L'), set(60, 10, 'R'),
    ], undefined)).toBe('2×10')
  })

  it('reads one side of a single-arm lift when the sides differ', () => {
    expect(lastTimeShape([
      set(60, 10, 'L'), set(60, 10, 'R'),
      set(60, 7, 'L'), set(60, 7, 'R'),
    ], undefined)).toBe('10/7')
  })

  it('prefers the prescribed count for legacy rows that recorded no side', () => {
    // Entries logged before `strength:side` existed have both sides as bare
    // rows, so the left-side filter cannot save them and six would be shown.
    expect(lastTimeShape([
      set(60, 10), set(60, 10), set(60, 10), set(60, 10), set(60, 10), set(60, 10),
    ], 3)).toBe('3×10')
  })

  it('says nothing rather than guessing when there are no sets', () => {
    expect(lastTimeShape([], 3)).toBe('?')
  })
})
