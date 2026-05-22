import { localSchemaFacet, refTargetFilterDefaultsFacet, typesFacet } from '@/data/facets'
import type { AppExtension } from '@/extensions/facet.js'
import { dailyNotesLocalSchema } from './localSchema.ts'
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType } from './schema.ts'

export const dailyNotesDataExtension: AppExtension = [
  typesFacet.of(dailyNoteType, {source: 'daily-notes'}),
  localSchemaFacet.of(dailyNotesLocalSchema, {source: 'daily-notes'}),
  refTargetFilterDefaultsFacet.of(
    {targetType: DAILY_NOTE_TYPE, property: dailyNoteDateProp.name},
    {source: 'daily-notes'},
  ),
]
