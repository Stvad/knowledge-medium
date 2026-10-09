// @vitest-environment happy-dom
/** What the review surface says about the live log's shape — rendered, since
 *  the stalled list and the ratios are read off the page, not off the data. */

import {cleanup, render, screen} from '@testing-library/react'
import {afterEach, describe, expect, it} from 'vitest'

import type {SetRecord, WorkoutRecord} from '../src/engine/types'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import {HistoryView} from '../src/ui/HistoryView'

afterEach(cleanup)

const at = (weight: number, ...reps: number[]): SetRecord[] => reps.map(r => ({weight, reps: r}))

const b = (day: string, exercises: WorkoutRecord['exercises']): WorkoutRecord => ({
  id: day, date: `${day}T12:00:00`, session: 'B', exercises,
})

const log: WorkoutRecord[] = [
  b('2026-08-23', [{exercise: 'Overhead press', sets: at(85, 7, 7, 7)}]),
  b('2026-09-06', [{exercise: 'Overhead press', sets: at(85, 8, 8, 7)}]),
  b('2026-09-13', [{exercise: 'Overhead press', sets: at(85, 9, 8, 7)}]),
  b('2026-09-20', [
    {exercise: 'Overhead press', sets: at(85, 10, 7, 6)},
    {exercise: 'Deadlift', sets: at(255, 8, 8)},
  ]),
  {id: 'a', date: '2026-09-17T12:00:00', session: 'A', exercises: [{exercise: 'Bench press', sets: at(140, 10, 9, 8)}]},
]

describe('HistoryView', () => {
  it('lists the stalled press with the reps behind it', () => {
    render(<HistoryView config={DEFAULT_CONFIG} history={log}/>)
    expect(screen.getByText('85lb for 4 sessions')).toBeTruthy()
    expect(screen.getByText('last: 10·7·6 / 9·8·7 / 8·8·7')).toBeTruthy()
  })

  it('shows the ratios the review checks', () => {
    render(<HistoryView config={DEFAULT_CONFIG} history={log}/>)
    expect(screen.getByText('OHP : bench').nextSibling?.textContent).toBe('0.61')
    expect(screen.getByText('Deadlift is the heaviest lift').nextSibling?.textContent).toContain('✓ 255')
  })

  it('has no stalled section when nothing is stuck', () => {
    render(<HistoryView config={DEFAULT_CONFIG} history={log.slice(1)}/>)
    // The positive case above proves the section renders from this data shape.
    expect(screen.queryByText('Stalled')).toBeNull()
  })
})
