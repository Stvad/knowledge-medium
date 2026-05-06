import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'
import { DAILY_NOTE_TYPE } from '@/data/blockTypes'

export const SRS_SM25_TYPE = 'srs-sm2.5'

export const srsIntervalProp = defineProperty<number>('interval', {
  codec: codecs.number,
  defaultValue: 2,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
})

export const srsFactorProp = defineProperty<number>('factor', {
  codec: codecs.number,
  defaultValue: 2.5,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
})

export const srsNextReviewDateProp = defineProperty<string>('next-review-date', {
  codec: codecs.ref({targetTypes: [DAILY_NOTE_TYPE]}),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
  kind: 'ref',
})

export const srsReviewCountProp = defineProperty<number>('review-count', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
})

export const srsSm25Type = defineBlockType({
  id: SRS_SM25_TYPE,
  label: 'SRS SM-2.5',
  properties: [
    srsIntervalProp,
    srsFactorProp,
    srsNextReviewDateProp,
    srsReviewCountProp,
  ],
})
