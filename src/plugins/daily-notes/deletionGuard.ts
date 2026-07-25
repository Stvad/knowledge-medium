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
import { DAILY_NOTE_TYPE, dailyNoteDateProp } from './schema.ts'

/**
 * Recognising a daily note: two independent signals, either of which suffices.
 *
 * There is no immutable one. The obvious candidate — the block ID, which is
 * `uuidv5(workspaceId:iso)` — can't be checked on its own because that hash
 * isn't reversible: you need the day, and the only place the day is recorded is
 * `dailyNoteDateProp`, which the property panel lets the user edit or delete.
 * The other candidate, `DAILY_NOTE_TYPE`, is a type chip the type editor lets
 * the user add to or remove from anything. Both were tried alone and each was
 * wrong in the direction the other covers:
 *
 *  - type alone: pull the chip off a real note and its subtree became
 *    deletable, with a later visit restoring the page shell while the contents
 *    stayed tombstoned — a delete that looks like it failed AND lost the day's
 *    notes;
 *  - id-from-date alone: edit the visible date field and the derivation stops
 *    matching, with exactly the same outcome. (`getOrCreateDailyNote`'s repair
 *    path doesn't currently include the date value in `needsRepair`, so an
 *    edited date doesn't self-heal on the next visit either.)
 *
 * Taking either signal as sufficient protects a real note unless the user has
 * stripped BOTH markers. The cost is the benign direction: a page deliberately
 * tagged as a daily note is refused even though it isn't one. That is a
 * discoverable, reversible annoyance — untag it — whereas the failure it
 * replaces destroys a day's notes.
 *
 * This is a UI affordance, not an invariant (see `BlockDeletionGuard`), so
 * heuristics over mutable metadata are the right altitude. A caller that really
 * means it still goes through `block.delete()`.
 */
export const dailyNotesDeletionGuard: BlockDeletionGuard = block => {
  const data = block.peek()
  if (!data) return null

  if (block.id === journalBlockId(data.workspaceId)) {
    return 'The Journal can’t be deleted — it’s recreated automatically as the home for daily notes.'
  }

  const date = block.peekProperty(dailyNoteDateProp)
  const derivedFromDate = date instanceof Date && !Number.isNaN(date.getTime())
    && block.id === dailyNoteBlockId(data.workspaceId, date.toISOString().slice(0, 10))

  if (derivedFromDate || block.hasType(DAILY_NOTE_TYPE)) {
    return 'Daily notes can’t be deleted — a note exists for every date, and revisiting it would bring the page back empty. Delete its contents instead.'
  }
  return null
}
