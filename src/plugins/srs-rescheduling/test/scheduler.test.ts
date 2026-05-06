import { describe, expect, it } from 'vitest'
import {
  getNewSrsParametersFromValues,
  scheduleSrsProperties,
  SrsSignal,
} from '../scheduler.ts'

const noJitter = () => 0.5
const may5 = new Date(2026, 4, 5)

describe('SRS scheduler', () => {
  it('schedules GOOD from default interval and factor', () => {
    expect(scheduleSrsProperties({interval: 2, factor: 2.5}, SrsSignal.GOOD, {
      now: may5,
      random: noJitter,
    })).toEqual({
      interval: 5,
      factor: 2.5,
      nextReviewDate: new Date(2026, 4, 10),
    })
  })

  it('updates existing interval and factor values', () => {
    expect(scheduleSrsProperties(
      {interval: 10, factor: 2},
      SrsSignal.HARD,
      {now: may5, random: noJitter},
    )).toEqual({
      interval: 13,
      factor: 1.85,
      nextReviewDate: new Date(2026, 4, 18),
    })
  })

  it('schedules SOONER from current values', () => {
    expect(scheduleSrsProperties(
      {interval: 2, factor: 2.5},
      SrsSignal.SOONER,
      {now: may5, random: noJitter},
    )).toEqual({
      interval: 1.5,
      factor: 2.5,
      nextReviewDate: new Date(2026, 4, 7),
    })
  })

  it('keeps the Anki lower ease bound for AGAIN', () => {
    expect(getNewSrsParametersFromValues(
      {interval: 5, factor: 1.35},
      SrsSignal.AGAIN,
      noJitter,
    )).toEqual({interval: 1, factor: 1.3})
  })
})
