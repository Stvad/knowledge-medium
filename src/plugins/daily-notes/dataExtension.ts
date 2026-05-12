import { typesFacet } from '@/data/facets'
import type { AppExtension } from '@/extensions/facet.ts'
import { dailyNoteType } from './schema.ts'

export const dailyNotesDataExtension: AppExtension = [
  typesFacet.of(dailyNoteType, {source: 'daily-notes'}),
]
