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
import { isJournalBlock } from './dailyNotes.ts'
import { DAILY_NOTE_TYPE } from './schema.ts'

/**
 * Recognising a daily note: the type chip, same as everywhere else.
 *
 * `DAILY_NOTE_TYPE` is what `getOrCreateDailyNote`'s own repair path checks to
 * decide whether a row still looks like a daily note, so the guard agreeing
 * with it keeps one notion of "is this a daily note" in the plugin.
 *
 * It is user-editable, and so is every alternative — the block id is a uuid,
 * and the only record of which day it belongs to is a property the panel lets
 * you edit. Reviews have proposed deriving identity from that date instead;
 * doing so just relocates the same mutability, and accepting either signal
 * makes any tagged page permanently undeletable. None of it is worth the
 * machinery: this is a UI affordance over a SOFT, undoable delete (see
 * `BlockDeletionGuard`). Strip the chip and you get the delete you asked for.
 */
export const dailyNotesDeletionGuard: BlockDeletionGuard = block => {
  const data = block.peek()
  if (!data) return null

  // `isJournalBlock` (alias-based) rather than an id comparison against
  // `journalBlockId`: the latter stops recognising the Journal once issue
  // #378's alias-first resolution has ADOPTED a different block as the
  // Journal (canonical row deleted, user aliased another page 'Journal');
  // the guard would then silently let that block be deleted.
  if (isJournalBlock(data)) {
    return 'The Journal can\u2019t be deleted \u2014 it\u2019s recreated automatically as the home for daily notes.'
  }
  if (block.hasType(DAILY_NOTE_TYPE)) {
    return 'Daily notes can\u2019t be deleted \u2014 a note exists for every date, and revisiting it would bring the page back empty. Delete its contents instead.'
  }
  return null
}
