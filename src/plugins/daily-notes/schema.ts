import {
  ChangeScope,
  codecs,
  definePresetCore,
  isRefCodec,
  type AnyPropertySchema,
  seedProperty,
  seedType,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'

export const DAILY_NOTE_TYPE = 'daily-note'

/** An unset day has no target. The optional ref preserves absence without inventing a date or an empty id. */
export const dayValuePresetCore = definePresetCore<string | undefined>({
  id: 'day',
  build: () => codecs.optionalRef({targetTypes: [DAILY_NOTE_TYPE]}),
  defaultValue: undefined,
})

export const isDayReferenceSchema = ({codec}: AnyPropertySchema): boolean =>
  isRefCodec(codec) && codec.targetTypes.length === 1 && codec.targetTypes[0] === DAILY_NOTE_TYPE

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
  hideInOutline: true,
})

export const dailyNoteType = seedType({
  seedKey: 'system:daily-notes/type/daily-note',
  revision: 1,
  id: DAILY_NOTE_TYPE,
  label: 'Daily note',
  properties: [aliasesProp, dailyNoteDateProp],
})
