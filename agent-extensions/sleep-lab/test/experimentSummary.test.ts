/** Unit tier for `summarizeExperiment`'s adherence count (src/ui/
 *  experimentSummary.ts) — pure, no repo. `LabPageContent`'s dashboard and
 *  the block's own `ExperimentFooter` both read this one computation, so a
 *  wrong adherence count here would be wrong in both places at once. */
import {describe, expect, it} from 'vitest'

import type {ExperimentRecord, NightRecord} from '../src/engine/types'
import {summarizeExperiment} from '../src/ui/experimentSummary'

const experiment: ExperimentRecord = {
  id: 'exp-1',
  intervention: 'glycine',
  doseText: '3 g glycine before bed',
  control: 'placebo',
  startDate: '2026-02-01',
  periodNights: 3,
  pairs: 1,
  seed: 0,
  status: 'running',
  periods: [],
}

const night = (over: Partial<NightRecord> & {id: string; date: string}): NightRecord => ({
  ratings: {},
  caffeineLate: false,
  lateMeal: false,
  unusual: false,
  naps: [],
  trained: false,
  doseRequired: false,
  experimentId: 'exp-1',
  ...over,
})

describe('summarizeExperiment — adherence', () => {
  it('counts taken over owing (doseRequired) nights only, an open-label control night not counted either way', () => {
    const nights: NightRecord[] = [
      night({id: 'n1', date: '2026-02-01', doseRequired: true, doseTaken: true}),
      night({id: 'n2', date: '2026-02-02', doseRequired: true, doseTaken: false}),
      // Open-label control: no dose owed, so it neither adds to `of` nor to `taken`.
      night({id: 'n3', date: '2026-02-03', doseRequired: false}),
    ]

    const summary = summarizeExperiment(experiment, nights, '2026-02-04')

    expect(summary.adherence).toEqual({taken: 1, of: 2})
  })

  it('is undefined when no night owes a dose', () => {
    const nights: NightRecord[] = [
      night({id: 'n1', date: '2026-02-01', doseRequired: false}),
      night({id: 'n2', date: '2026-02-02', doseRequired: false}),
    ]

    const summary = summarizeExperiment(experiment, nights, '2026-02-03')

    expect(summary.adherence).toBeUndefined()
  })

  it('is undefined with no nights at all', () => {
    const summary = summarizeExperiment(experiment, [], '2026-02-01')

    expect(summary.adherence).toBeUndefined()
  })
})
