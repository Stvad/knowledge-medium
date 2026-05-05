import { describe, expect, it } from 'vitest'
import {
  getNewSrsParameters,
  scheduleSrsContent,
  SrsSignal,
} from '../scheduler.ts'

const noJitter = () => 0.5
const may5 = new Date(2026, 4, 5)

describe('SRS scheduler', () => {
  it('matches the roam-date GOOD semantics for default interval and factor', () => {
    expect(scheduleSrsContent('Review [[May 1st, 2026]]', SrsSignal.GOOD, {
      now: may5,
      random: noJitter,
    })).toBe('Review [[May 10th, 2026]] [[[[interval]]:5.0]] [[[[factor]]:2.50]] *')
  })

  it('updates existing interval and factor properties in place', () => {
    expect(scheduleSrsContent(
      'Review [[[[interval]]:10.0]] [[[[factor]]:2.00]] [[May 1st, 2026]]',
      SrsSignal.HARD,
      {now: may5, random: noJitter},
    )).toBe('Review [[[[interval]]:13.0]] [[[[factor]]:1.85]] [[May 18th, 2026]] *')
  })

  it('appends the new date when the block has multiple date references', () => {
    expect(scheduleSrsContent(
      'Review [[May 1st, 2026]] and [[May 2nd, 2026]]',
      SrsSignal.SOONER,
      {now: may5, random: noJitter},
    )).toBe(
      'Review [[May 1st, 2026]] and [[May 2nd, 2026]] ' +
      '[[[[interval]]:1.5]] [[[[factor]]:2.50]] [[May 7th, 2026]] *',
    )
  })

  it('keeps the Anki lower ease bound for AGAIN', () => {
    expect(getNewSrsParameters(
      'Review [[[[interval]]:5.0]] [[[[factor]]:1.35]]',
      SrsSignal.AGAIN,
      noJitter,
    )).toEqual({interval: 1, factor: 1.3})
  })
})
