// @vitest-environment happy-dom
/** Rendering tests for `ExperimentFooter`, exported raw from
 *  `./decorations/ExperimentFooter` rather than through
 *  `cachedContentDecorator`/`blockChildrenFooterFacet` — see `ui.test.tsx`
 *  and that module's own doc comment for why: those facets have no runtime
 *  under this tier's kernel-type stubs.
 *
 *  `km/experiment` is mocked wholesale for the same reason `ui.test.tsx`
 *  mocks it: it imports kernel VALUES (`propertyValue`, `createTypedChild`,
 *  …) from un-aliased `@/data/*` paths, so importing it for real fails at
 *  module load regardless of which export is actually used.
 */
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {publishLayoffs, resetBlockHooks} from './kernel/blockHooks'

const stampSchedule = vi.fn()
vi.mock('../src/km/experiment', () => ({stampSchedule: (...args: unknown[]) => stampSchedule(...args)}))

const {ExperimentFooter} = await import('../src/ui/decorations/ExperimentFooter')
const {FIELD, EXPERIMENT_TYPE, PERIOD_TYPE} = await import('../src/km/fields')
const {addDays, tonightWakeDate} = await import('../src/km/day')

afterEach(() => cleanup())

const fakeBlock = (id: string, isReadOnly = false) => ({id, repo: {isReadOnly}}) as never

const experimentRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  parentId: 'page-1',
  orderKey: id,
  properties: {
    types: [EXPERIMENT_TYPE],
    [FIELD.intervention]: 'glycine',
    [FIELD.doseText]: '3 g glycine',
    [FIELD.control]: 'nothing',
    [FIELD.startDate]: '2026-01-01T12:00:00.000Z',
    [FIELD.periodNights]: 3,
    [FIELD.pairs]: 1,
    [FIELD.seed]: 1,
    [FIELD.experimentStatus]: 'running',
    ...overrides,
  },
})

const periodRow = (
  id: string, experimentId: string, index: number, arm: 'intervention' | 'control', from: string, to: string,
) => ({
  id,
  parentId: experimentId,
  orderKey: id,
  properties: {
    types: [PERIOD_TYPE],
    [FIELD.index]: index,
    [FIELD.pair]: 1,
    [FIELD.arm]: arm,
    [FIELD.from]: `${from}T12:00:00.000Z`,
    [FIELD.to]: `${to}T12:00:00.000Z`,
  },
})

beforeEach(() => {
  resetBlockHooks()
  stampSchedule.mockReset()
})

describe('an experiment with no periods yet', () => {
  it('offers Stamp schedule, and calls stampSchedule with the block id on click', async () => {
    stampSchedule.mockResolvedValue({status: 'already'})
    publishLayoffs([experimentRow('exp-1')])

    render(<ExperimentFooter block={fakeBlock('exp-1')}/>)

    expect(screen.getByText('Not in the schedule window')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', {name: 'Stamp schedule'}))

    expect(stampSchedule).toHaveBeenCalledWith(expect.anything(), 'exp-1')
    expect(await screen.findByText('This experiment already has its schedule.')).toBeTruthy()
  })

  it('shows the unreadable reason as text', async () => {
    stampSchedule.mockResolvedValue({status: 'unreadable', reason: 'Set a start date first.'})
    publishLayoffs([experimentRow('exp-1')])

    render(<ExperimentFooter block={fakeBlock('exp-1')}/>)
    fireEvent.click(screen.getByRole('button', {name: 'Stamp schedule'}))

    expect(await screen.findByText('Set a start date first.')).toBeTruthy()
  })

  it('logs and shows a generic message when the write throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stampSchedule.mockRejectedValue(new Error('boom'))
    publishLayoffs([experimentRow('exp-1')])

    render(<ExperimentFooter block={fakeBlock('exp-1')}/>)
    fireEvent.click(screen.getByRole('button', {name: 'Stamp schedule'}))

    expect(await screen.findByText('Could not stamp the schedule — try again.')).toBeTruthy()
    expect(console.error).toHaveBeenCalledWith('[sleep-lab] could not stamp the schedule', expect.any(Error))
  })

  it('shows no button on a read-only repo', () => {
    publishLayoffs([experimentRow('exp-1')])

    render(<ExperimentFooter block={fakeBlock('exp-1', true)}/>)

    expect(screen.queryByRole('button', {name: 'Stamp schedule'})).toBeNull()
  })
})

describe('an experiment with a stamped schedule', () => {
  it('shows no button, and progress anchored on tonight\'s wake date', () => {
    const tonight = tonightWakeDate()
    const from = addDays(tonight, -2)
    const to = addDays(tonight, 3)

    publishLayoffs([
      experimentRow('exp-1'),
      periodRow('period-1', 'exp-1', 1, 'intervention', from, to),
    ])

    render(<ExperimentFooter block={fakeBlock('exp-1')}/>)

    expect(screen.queryByRole('button', {name: 'Stamp schedule'})).toBeNull()
    expect(screen.getByText('Night 3 of 6')).toBeTruthy()
    expect(screen.getByText('Tonight: intervention')).toBeTruthy()
  })
})
