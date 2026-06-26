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
import { getOrCreateDailyNote, todayIso } from './dailyNotes.ts'

export const todayDailyNoteLanding: WorkspaceLandingResolver = async ({
  repo,
  workspaceId,
}) => {
  const dailyNote = await getOrCreateDailyNote(repo, workspaceId, todayIso())
  return dailyNote.id
}
