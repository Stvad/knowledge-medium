import {
  localSchemaFacet,
  refTargetFilterDefaultsFacet,
  typesFacet,
  workspaceBackfillsFacet,
} from '@/data/facets'
import type { AppExtension } from '@/facets/facet.js'
import { dailyNoteDateBackfill } from './backfill.ts'
import { dailyNotesLocalSchema } from './localSchema.ts'
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType } from './schema.ts'

export const dailyNotesDataExtension: AppExtension = [
  typesFacet.of(dailyNoteType, {source: 'daily-notes'}),
  localSchemaFacet.of(dailyNotesLocalSchema, {source: 'daily-notes'}),
  workspaceBackfillsFacet.of(dailyNoteDateBackfill, {source: 'daily-notes'}),
  refTargetFilterDefaultsFacet.of(
    {targetType: DAILY_NOTE_TYPE, property: dailyNoteDateProp.name},
    {source: 'daily-notes'},
  ),
]

export default dailyNotesDataExtension
