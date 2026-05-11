import { defineBlockType, type TypeContribution } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'

export const DAILY_NOTE_TYPE = 'daily-note'

export const dailyNoteType: TypeContribution = defineBlockType({
  id: DAILY_NOTE_TYPE,
  label: 'Daily note',
  properties: [aliasesProp],
})
