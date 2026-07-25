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
import { dailyNoteBlockId, journalBlockId } from './dailyNotes.ts'
import { dailyNoteDateProp } from './schema.ts'

/**
 * Identity, not type membership.
 *
 * Keying off `DAILY_NOTE_TYPE` looked equivalent and isn't: types are ordinary
 * user-editable metadata (the type editor lets you drop a chip from any block
 * and add a registered type to any other). Keyed that way the guard got BOTH
 * directions wrong — pull the chip off a real daily note and its subtree became
 * deletable, with a revisit restoring the page shell while the contents stayed
 * tombstoned; tag an ordinary page as a daily note and that page became
 * permanently undeletable.
 *
 * What actually makes a block one of this plugin's get-or-create records is its
 * ID, which is `uuidv5(workspaceId:iso)`. That hash isn't reversible, so the
 * day comes from the note's own `dailyNoteDateProp` and the id is recomputed
 * from it: a page that isn't at its derived address isn't a daily note,
 * whatever it's tagged. A genuine note always carries the date — the
 * get-or-create repair path writes it — so nothing legitimate falls through.
 */
export const dailyNotesDeletionGuard: BlockDeletionGuard = block => {
  const data = block.peek()
  if (!data) return null

  if (block.id === journalBlockId(data.workspaceId)) {
    return 'The Journal can’t be deleted — it’s recreated automatically as the home for daily notes.'
  }

  const date = block.peekProperty(dailyNoteDateProp)
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    const iso = date.toISOString().slice(0, 10)
    if (block.id === dailyNoteBlockId(data.workspaceId, iso)) {
      return 'Daily notes can’t be deleted — a note exists for every date, and revisiting it would bring the page back empty. Delete its contents instead.'
    }
  }
  return null
}
