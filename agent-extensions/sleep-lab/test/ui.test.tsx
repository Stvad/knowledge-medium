// @vitest-environment happy-dom
/** Rendering tests for the two React surfaces this extension owns:
 *  `LabPageContent` (the dashboard) and `NightLine` (the night check-in
 *  row). `NightLine` renders straight from `./decorations/NightLine`, not
 *  through `cachedContentDecorator` — that wrapping happens in
 *  `./decorations/index` instead (see that file's doc comment), precisely
 *  so this module never has to load `@/extensions/blockInteraction.js`,
 *  which — like the facet registries `LabPageRenderer`'s wrapper touches —
 *  has no runtime under this tier's kernel-type stubs (declarations only).
 *
 *  Every km module either surface touches gets mocked wholesale for the
 *  same reason `test/startAction.test.ts` mocks `km/session` etc. —
 *  `km/nights` and `km/experiment` both import kernel VALUES
 *  (`propertyValue`, `createTypedChild`, …) from un-aliased `@/data/*`
 *  paths, so importing them for real fails at module load regardless of
 *  which export is actually used.
 */
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {publishLayoffs, resetBlockHooks, WORKSPACE_ID} from './kernel/blockHooks'

vi.mock('../src/km/nights', () => ({
  writeRating: vi.fn(),
  writeCovariates: vi.fn(),
  markDoseTaken: vi.fn(),
  importSessions: vi.fn(),
}))
vi.mock('../src/km/experiment', () => ({
  // The one real bit of logic these tests lean on — trivial enough to
  // restate here rather than mock away, and restating it is what lets the
  // "which experiment is running" behaviour stay pinned.
  runningExperiment: (experiments: readonly {status: string}[]) => experiments.find(e => e.status === 'running'),
  createExperiment: vi.fn(),
  stampNight: vi.fn(),
}))

const {writeRating} = await import('../src/km/nights')
const {NightLine} = await import('../src/ui/decorations/NightLine')
const {LabPageContent} = await import('../src/ui/LabPageContent')
const {FIELD, NIGHT_TYPE, EXPERIMENT_TYPE, PERIOD_TYPE} = await import('../src/km/fields')
const {addDays, tonightWakeDate} = await import('../src/km/day')

afterEach(() => cleanup())

const fakeBlock = (id: string) => ({id, repo: {isReadOnly: false}}) as never
const Inner = () => <div data-testid="inner"/>

const nightRow = (
  id: string, date: string, arm: 'intervention' | 'control', quality?: number,
  extra: {experimentId?: string; alcohol?: number; periodId?: string} = {},
) => ({
  id,
  parentId: 'page-1',
  orderKey: id,
  properties: {
    types: [NIGHT_TYPE],
    [FIELD.date]: `${date}T12:00:00.000Z`,
    [FIELD.arm]: arm,
    ...(quality !== undefined ? {[FIELD.quality]: quality} : {}),
    ...(extra.experimentId !== undefined ? {[FIELD.experiment]: extra.experimentId} : {}),
    ...(extra.alcohol !== undefined ? {[FIELD.alcohol]: extra.alcohol} : {}),
    ...(extra.periodId !== undefined ? {[FIELD.period]: extra.periodId} : {}),
  },
})

const experimentRow = (id: string, intervention: string, status: 'planned' | 'running' | 'done', startDate: string) => ({
  id,
  parentId: 'page-1',
  orderKey: id,
  properties: {
    types: [EXPERIMENT_TYPE],
    [FIELD.intervention]: intervention,
    [FIELD.doseText]: `${intervention} dose`,
    [FIELD.control]: 'nothing',
    [FIELD.startDate]: `${startDate}T12:00:00.000Z`,
    [FIELD.periodNights]: 3,
    [FIELD.pairs]: 1,
    [FIELD.seed]: 1,
    [FIELD.experimentStatus]: status,
  },
})

describe('NightLine', () => {
  beforeEach(() => {
    resetBlockHooks()
    vi.mocked(writeRating).mockReset().mockResolvedValue('written')
    publishLayoffs([nightRow('night-x', '2026-01-05', 'intervention')])
  })

  it('writes the tapped rating through the km write path', async () => {
    render(<NightLine block={fakeBlock('night-x')} Inner={Inner}/>)

    fireEvent.click(screen.getByRole('button', {name: 'Quality 4'}))

    expect(writeRating).toHaveBeenCalledWith(expect.anything(), 'night-x', 'quality', 4)
  })

  it('shows the refusal when the write reports the night is gone', async () => {
    vi.mocked(writeRating).mockResolvedValueOnce('gone')
    render(<NightLine block={fakeBlock('night-x')} Inner={Inner}/>)

    fireEvent.click(screen.getByRole('button', {name: 'Rested 3'}))

    expect(await screen.findByText(/no longer there/)).toBeTruthy()
  })
})

describe('LabPageContent', () => {
  beforeEach(() => {
    resetBlockHooks()
  })

  it('shows the running experiment\'s progress, tonight\'s arm, and a comparison row', () => {
    // The page asks the schedule about the sleep AHEAD, so the fixture is
    // anchored on tonight's wake date, not the calendar date.
    const tonight = tonightWakeDate()
    const period1: [string, string] = [addDays(tonight, -5), addDays(tonight, -3)]
    const period2: [string, string] = [addDays(tonight, -2), tonight]

    const periodRow = (id: string, index: number, arm: 'intervention' | 'control', from: string, to: string) => ({
      id,
      parentId: 'exp-1',
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

    publishLayoffs([
      experimentRow('exp-1', 'glycine', 'running', period1[0]),
      periodRow('period-1', 1, 'control', period1[0], period1[1]),
      periodRow('period-2', 2, 'intervention', period2[0], period2[1]),
      // Every night points at the (one) running experiment: the analysis
      // table now reads one experiment's nights, never the whole workspace.
      // Each night also points at its period (`FIELD.period`), the ref
      // `buildNights` reads to derive `pair` — both control nights share
      // period-1's pair with both intervention nights sharing period-2's,
      // so this fixture yields one complete pair for the paired estimate.
      nightRow('night-1', addDays(tonight, -5), 'control', 3, {experimentId: 'exp-1', periodId: 'period-1'}),
      nightRow('night-2', addDays(tonight, -4), 'control', 3, {experimentId: 'exp-1', periodId: 'period-1'}),
      nightRow('night-3', addDays(tonight, -2), 'intervention', 4, {experimentId: 'exp-1', periodId: 'period-2'}),
      nightRow('night-4', addDays(tonight, -1), 'intervention', 4, {experimentId: 'exp-1', periodId: 'period-2'}),
    ])

    render(<LabPageContent block={fakeBlock('page-1')}/>)

    expect(screen.getByText('Night 6 of 6')).toBeTruthy()
    expect(screen.getByText('Tonight: intervention')).toBeTruthy()

    const row = screen.getByText(/Sleep quality/).closest('tr')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('2/2')
    expect(row!.textContent).toContain('4.00')
    expect(row!.textContent).toContain('3.00')
    expect(row!.textContent).toContain('1.00')
    // Paired Δ: one pair (both periods share pair 1), intervention mean 4
    // minus control mean 3 — too few pairs (1 < 3) for a bootstrap CI.
    expect(row!.textContent).toContain('1.00 (1 pair)')
  })

  it('shows the empty states with no experiment and no nights', () => {
    publishLayoffs([])

    render(<LabPageContent block={fakeBlock('page-1')}/>)

    expect(screen.getByText('No experiment is running. Start one to begin the schedule.')).toBeTruthy()
    expect(screen.getAllByText('No nights logged yet.')).toHaveLength(2)
  })

  it('restricts the analysis to one experiment (the running one by default), and the picker switches it', () => {
    // exp-1 is running but older; exp-2 is newer but done — the default must
    // pick the RUNNING one, not the newest, so the two disagree on purpose.
    publishLayoffs([
      experimentRow('exp-1', 'glycine', 'running', '2026-01-01'),
      experimentRow('exp-2', 'melatonin', 'done', '2026-02-01'),
      nightRow('night-1', '2026-01-05', 'intervention', 5, {experimentId: 'exp-1'}),
      nightRow('night-2', '2026-01-06', 'control', 1, {experimentId: 'exp-1'}),
      nightRow('night-3', '2026-02-05', 'intervention', 4, {experimentId: 'exp-2'}),
      nightRow('night-4', '2026-02-06', 'control', 2, {experimentId: 'exp-2'}),
    ])

    render(<LabPageContent block={fakeBlock('page-1')}/>)

    const qualityRow = () => screen.getByText(/Sleep quality/).closest('tr')!
    expect(qualityRow().textContent).toContain('1/1')
    expect(qualityRow().textContent).toContain('5.00')
    expect(qualityRow().textContent).toContain('1.00')

    fireEvent.click(screen.getByRole('button', {name: /melatonin/}))

    expect(qualityRow().textContent).toContain('4.00')
    expect(qualityRow().textContent).toContain('2.00')
  })

  it('excludes nights with 2+ drinks from the comparison once the alcohol sensitivity toggle is on', () => {
    publishLayoffs([
      experimentRow('exp-1', 'glycine', 'running', '2026-01-01'),
      nightRow('night-1', '2026-01-05', 'intervention', 4, {experimentId: 'exp-1', alcohol: 2}),
      nightRow('night-2', '2026-01-06', 'intervention', 4, {experimentId: 'exp-1'}),
      nightRow('night-3', '2026-01-07', 'control', 2, {experimentId: 'exp-1'}),
    ])

    render(<LabPageContent block={fakeBlock('page-1')}/>)

    const qualityRow = () => screen.getByText(/Sleep quality/).closest('tr')!
    // Before the toggle: both intervention nights count, alcohol or not.
    expect(qualityRow().textContent).toContain('2/1')

    fireEvent.click(screen.getByRole('checkbox', {name: /2\+ drinks/}))

    // After: the 2-drink night drops out; the night with no alcohol logged stays.
    expect(qualityRow().textContent).toContain('1/1')
  })
})

it('publishes rows under the fixed workspace id every test uses', () => {
  expect(WORKSPACE_ID).toBe('ws-1')
})
