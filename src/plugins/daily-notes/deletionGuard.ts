/**
 * Refuse UI deletion of the pages this plugin owns by construction.
 *
 * A daily note and the Journal are get-or-CREATE: every navigation to a date
 * calls `getOrCreateDailyNote`, which RESTORES a soft-deleted row rather than
 * making a new one. So deleting one never sticks — revisit the date and the
 * page is back. Worse, `delete` cascades to the subtree while `tx.restore` is
 * single-row, so what comes back is the page WITHOUT its contents: the gesture
 * looks like it failed while having thrown away the day's notes.
 *
 * Refusing is the honest answer. The date's page always exists; what the user
 * can meaningfully delete is its contents.
 *
 * UI-layer only, by design (see `BlockDeletionGuard`): a programmatic caller
 * that really means it still goes through `block.delete()`.
 */
import type { BlockDeletionGuard } from '@/extensions/core.js'
import { journalBlockId } from './dailyNotes.ts'
import { DAILY_NOTE_TYPE } from './schema.ts'

export const dailyNotesDeletionGuard: BlockDeletionGuard = block => {
  const data = block.peek()
  if (!data) return null

  if (block.hasType(DAILY_NOTE_TYPE)) {
    return 'Daily notes can’t be deleted — a note exists for every date, and revisiting it would bring the page back empty. Delete its contents instead.'
  }
  if (block.id === journalBlockId(data.workspaceId)) {
    return 'The Journal can’t be deleted — it’s recreated automatically as the home for daily notes.'
  }
  return null
}
