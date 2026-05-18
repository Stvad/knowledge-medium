import { localSchemaFacet, typesFacet } from '@/data/facets'
import type { AppExtension } from '@/extensions/facet.ts'
import { dailyNotesLocalSchema } from './localSchema.ts'
import { dailyNoteType } from './schema.ts'

export const dailyNotesDataExtension: AppExtension = [
  typesFacet.of(dailyNoteType, {source: 'daily-notes'}),
  localSchemaFacet.of(dailyNotesLocalSchema, {source: 'daily-notes'}),
]
