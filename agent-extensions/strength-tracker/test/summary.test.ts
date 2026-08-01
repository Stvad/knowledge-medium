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

  it('counts what was performed, not what was prescribed', () => {
    // `buildHistory` hands over only the ticked rows, so a lift cut short at
    // two of three arrives here with two. Printing the prescribed 3 said you
    // had finished it — the same lie the `10/8/7` rule above exists to
    // prevent, by another route, and one progression does not tell: it treats
    // the short session as incomplete and holds the load, so the line and the
    // next prescription disagreed about the session you lift against.
    expect(lastTimeShape([set(135, 10), set(135, 10)], 3)).toBe('2×10')
  })

  it('still reads legacy side-less rows as the prescribed count', () => {
    // Entries logged before `strength:side` existed have both sides as bare
    // rows, so nothing can halve them and six would be shown. Recognised by
    // the doubling itself — no side anywhere, exactly twice the prescription.
    expect(lastTimeShape([
      set(60, 10), set(60, 10), set(60, 10), set(60, 10), set(60, 10), set(60, 10),
    ], 3)).toBe('3×10')
  })

  it('does not call rows legacy when any one of them does claim a side', () => {
    // Reachable only by hand-editing: `progressionSets` already returns every
    // row when NO row has a side, so in practice the doubled-count test alone
    // decides. This pins the side clause directly — a half-sided entry is
    // damaged, and reporting the six rows it has beats asserting the three it
    // was prescribed.
    expect(lastTimeShape([
      set(60, 10, 'L'), set(60, 10), set(60, 10),
      set(60, 10), set(60, 10), set(60, 10),
    ], 3)).toBe('6×10')
  })

  it('does not mistake an over-delivered lift for legacy doubling', () => {
    // Four sets against a prescribed three is not the doubled shape, so the
    // count stands rather than being rewritten to the prescription.
    expect(lastTimeShape([
      set(135, 10), set(135, 10), set(135, 10), set(135, 10),
    ], 3)).toBe('4×10')
  })

  it('says nothing rather than guessing when there are no sets', () => {
    expect(lastTimeShape([], 3)).toBe('?')
  })
})
