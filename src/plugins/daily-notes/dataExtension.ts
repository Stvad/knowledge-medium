import {
  localSchemaFacet,
  refTargetFilterDefaultsFacet,
  systemPagesFacet,
  typesFacet,
  workspaceBackfillsFacet,
} from '@/data/facets'
import type { AppExtension } from '@/facets/facet.js'
import { dailyNoteDateBackfill } from './backfill.ts'
import { getOrCreateJournalBlock } from './dailyNotes.ts'
import { dailyNotesLocalSchema } from './localSchema.ts'
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType } from './schema.ts'

export const dailyNotesDataExtension: AppExtension = [
  typesFacet.of(dailyNoteType, {source: 'daily-notes'}),
  localSchemaFacet.of(dailyNotesLocalSchema, {source: 'daily-notes'}),
  workspaceBackfillsFacet.of(dailyNoteDateBackfill, {source: 'daily-notes'}),
  // Eagerly materialise the Journal page at bootstrap so `[[Journal]]` resolves
  // to it instead of auto-creating a rival claimant (alias.collision).
  systemPagesFacet.of({id: 'daily-notes:journal', ensure: getOrCreateJournalBlock}, {source: 'daily-notes'}),
  refTargetFilterDefaultsFacet.of(
    {targetType: DAILY_NOTE_TYPE, property: dailyNoteDateProp.name},
    {source: 'daily-notes'},
  ),
]
