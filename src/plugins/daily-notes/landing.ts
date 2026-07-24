/**
 * Landing resolver: when the app boots into an empty layout (URL hash
 * has no panels), land the user on today's daily note. Get-or-create
 * the note via the deterministic-id helper so two clients booting
 * offline converge on the same row when they later sync.
 *
 * First-run discoverability (the `[[Tutorial]]` bullet) is NOT handled
 * here — that belongs to the onboarding plugin, which contributes its own
 * higher-precedence landing resolver, seeds the Tutorial pages, drops the
 * bullet on today's note, and then defers the landing target back to this
 * resolver. So daily-notes no longer knows anything about the tutorial.
 *
 * Returns the block id of today's daily note. App.tsx is responsible
 * for the rest of the bootstrap chain (replaceHash, panel-row tx);
 * the resolver intentionally stops here so the same surface can be
 * used to land somewhere that isn't a daily note (e.g. a future
 * "open last panel" plugin) without duplicating the navigation
 * plumbing.
 */
import type { WorkspaceLandingResolver } from '@/extensions/core.js'
import { dailyNoteBlockId, getOrCreateDailyNote, journalBlockId, todayIso } from './dailyNotes.ts'

export const todayDailyNoteLanding: WorkspaceLandingResolver = async ({
  repo,
  workspaceId,
  excludeBlockId,
}) => {
  const iso = todayIso()
  const id = dailyNoteBlockId(workspaceId, iso)
  if (excludeBlockId) {
    // Recovery context. `getOrCreateDailyNote` RESTORES a soft-deleted row, so
    // answering here can undo a delete. Decline when we'd hand back the
    // excluded block itself (id is a pure function of workspace+day, so this
    // costs nothing)...
    if (id === excludeBlockId) return null
    // ...and, more broadly, whenever today's note is currently a tombstone.
    // The excluded id is the vanished page of the pane being recovered, which
    // is NOT necessarily the root of the deleted subtree: a pane zoomed into a
    // CHILD of today's note recovers with the child's id, and an exact-id check
    // would sail past and resurrect the deleted parent note. A tombstone means
    // someone deleted it; recovery is never the right moment to bring it back.
    //
    // The Journal counts too: `getOrCreateDailyNote` calls
    // `getOrCreateJournalBlock`, which restores a soft-deleted Journal row — so
    // recovering after a Journal delete would resurrect it and hang a fresh
    // daily note under it.
    //
    // Read the rows directly: `block.load()` returns null for BOTH a tombstone
    // and a missing row, and markMissing's the tombstone on the way, so the
    // Block facade can't tell "deleted" (decline) from "never existed"
    // (creating it is fine and wanted).
    const rows = await repo.db.getAll<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id IN (?, ?)', [id, journalBlockId(workspaceId)],
    )
    if (rows.some(row => row.deleted === 1)) return null
  }
  const dailyNote = await getOrCreateDailyNote(repo, workspaceId, iso)
  return dailyNote.id
}
