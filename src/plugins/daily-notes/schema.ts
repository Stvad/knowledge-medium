import {
  ChangeScope,
  defineBlockType,
  seedProperty,
  type TypeContribution,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'

export const DAILY_NOTE_TYPE = 'daily-note'

/** Indexable calendar-day value for a daily-note page. Lets the query
 *  layer resolve ref-typed properties that point at daily notes
 *  (e.g. SRS's `next-review-date`) as comparable dates without
 *  parsing aliases at query time. Populated at write by
 *  `getOrCreateDailyNote` / `ensureDailyNoteTarget` and backfilled
 *  once per device from the ISO alias for pre-existing rows. */
export const dailyNoteDateProp = seedProperty({
  seedKey: 'system:daily-notes/property/date',
  revision: 1,
  name: 'daily-note:date',
  preset: 'date',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const dailyNoteType: TypeContribution = defineBlockType({
  id: DAILY_NOTE_TYPE,
  label: 'Daily note',
  properties: [aliasesProp, dailyNoteDateProp],
})
