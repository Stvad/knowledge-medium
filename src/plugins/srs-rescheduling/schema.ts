import { ChangeScope, seedProperty, seedType, type PropertySeedDeclaration, INFRASTRUCTURE_TYPE_DISPLAY } from '@/data/api'
// Sub-path import (not the barrel) — `schema.ts` is loaded from
// `srsReschedulingDataExtension`, which is in the static-data graph.
// Importing the barrel would force daily-notes/index.ts to evaluate
// before React boots, dragging `@/extensions/blockInteraction` and
// closing a load-time cycle through globalState → repoProvider.
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'

export const SRS_SM25_TYPE = 'srs-sm2.5'

export interface SrsReviewSnapshot {
  reviewedAt: string
  grade: number
  interval: number
  factor: number
  reviewCount: number
}

export const srsIntervalProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/interval',
  revision: 1,
  name: 'interval',
  preset: 'number',
  defaultValue: 2,
  changeScope: ChangeScope.BlockDefault,
})

export const srsFactorProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/factor',
  revision: 1,
  name: 'factor',
  preset: 'number',
  defaultValue: 2.5,
  changeScope: ChangeScope.BlockDefault,
})

export const srsNextReviewDateProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/next-review-date',
  revision: 1,
  name: 'next-review-date',
  preset: 'ref',
  config: {targetTypes: [DAILY_NOTE_TYPE]},
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

export const srsReviewCountProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/review-count',
  revision: 1,
  name: 'review-count',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

export const srsGradeProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/grade',
  revision: 1,
  name: 'grade',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

export const srsArchivedProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/archived',
  revision: 1,
  name: 'archived',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const srsSnapshotHistoryProp = seedProperty({
  seedKey: 'system:srs-rescheduling/property/snapshot-history',
  revision: 1,
  name: 'snapshot-history',
  preset: 'list',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
// The shared list core is runtime-equivalent to the historical
// list(unsafeIdentity<SrsReviewSnapshot>()) codec. Keep the typed handle local.
}) as PropertySeedDeclaration<SrsReviewSnapshot[]>

export const srsSm25Type = seedType({
  seedKey: 'system:srs-rescheduling/type/srs-sm2.5',
  revision: 1,
  id: SRS_SM25_TYPE,
  label: 'SRS SM-2.5',
  ...INFRASTRUCTURE_TYPE_DISPLAY,
  properties: [
    srsIntervalProp,
    srsFactorProp,
    srsNextReviewDateProp,
    srsReviewCountProp,
    srsGradeProp,
    srsArchivedProp,
    srsSnapshotHistoryProp,
  ],
})
