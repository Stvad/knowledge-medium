import {describe, expect, it} from 'vitest'

import type {SetRecord} from '../src/engine/types'
import {lastTimeShape} from '../src/ui/summary'

const set = (weight: number, reps: number, side?: 'L' | 'R'): SetRecord =>
  ({weight, reps, ...(side ? {side} : {})})

describe('lastTimeShape', () => {
  it('uses the compact form when every set really did match', () => {
    expect(lastTimeShape([set(135, 10), set(135, 10), set(135, 10)])).toBe('3×10')
  })

  it('spells out the reps when they differ', () => {
    // `3×10` is a claim about every set, and 10/8/7 is an ordinary session —
    // reported compactly it reads as a clean top-of-range performance, which
    // is the shape that says "add load", against a session that fatigued.
    expect(lastTimeShape([set(135, 10), set(135, 8), set(135, 7)])).toBe('10/8/7')
  })

  it('counts a single-arm lift by its left side, not by its rows', () => {
    // Each prescribed set is stored as an L row and an R row, so counting
    // rows called a three-set lift six.
    expect(lastTimeShape([
      set(60, 10, 'L'), set(60, 10, 'R'),
      set(60, 10, 'L'), set(60, 10, 'R'),
    ])).toBe('2×10')
  })

  it('reads one side of a single-arm lift when the sides differ', () => {
    expect(lastTimeShape([
      set(60, 10, 'L'), set(60, 10, 'R'),
      set(60, 7, 'L'), set(60, 7, 'R'),
    ])).toBe('10/7')
  })

  it('counts what was performed, not what was prescribed', () => {
    // `buildHistory` hands over only the ticked rows, so a lift cut short at
    // two of three arrives here with two. Printing the prescribed 3 said you
    // had finished it — the same lie the `10/8/7` rule above exists to
    // prevent, by another route, and one progression does not tell: it treats
    // the short session as incomplete and holds the load, so the line and the
    // next prescription disagreed about the session you lift against.
    expect(lastTimeShape([set(135, 10), set(135, 10)])).toBe('2×10')
  })

  it('reports double the prescribed volume as the six sets it actually was', () => {
    // This used to read `3×10`. Rows predating `strength:side` stored both
    // sides bare, and that shape was inferred from "exactly twice the
    // prescription, and no row claiming a side" — which is the SAME shape as
    // adding three sets to a prescribed three and ticking them, an ordinary
    // session. Under-reporting what you did, on the line you load the next bar
    // against, is the worse error, and it lands on live sessions rather than
    // pre-migration ones. Genuine single-arm work is unaffected and needs no
    // arithmetic — it says so with `strength:side`, pinned above.
    expect(lastTimeShape([
      set(60, 10), set(60, 10), set(60, 10), set(60, 10), set(60, 10), set(60, 10),
    ])).toBe('6×10')
  })

  it('reports the rows a half-sided entry actually has', () => {
    // Reachable only by hand-editing. `progressionSets` drops the `R` rows as
    // soon as ANY row claims a side, so a damaged entry reports what survives
    // that filter rather than guessing at what it was prescribed.
    expect(lastTimeShape([
      set(60, 10, 'L'), set(60, 10), set(60, 10),
      set(60, 10), set(60, 10), set(60, 10),
    ])).toBe('6×10')
  })

  it('reports an over-delivered lift at the count it reached', () => {
    expect(lastTimeShape([
      set(135, 10), set(135, 10), set(135, 10), set(135, 10),
    ])).toBe('4×10')
  })

  it('says nothing rather than guessing when there are no sets', () => {
    expect(lastTimeShape([])).toBe('?')
  })
})
