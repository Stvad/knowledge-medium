/**
 * Landing resolver: when the app boots into an empty layout (URL hash
 * has no panels), land the user on today's daily note. Get-or-create
 * the note via the deterministic-id helper so two clients booting
 * offline converge on the same row when they later sync.
 *
 * On `freshlyCreated` workspaces also prepend a `[[Tutorial]]` bullet
 * so the welcome content is one click away from the landing page —
 * this matches the historical first-run behavior that lived in
 * App.tsx before the daily-notes feature became a plugin.
 *
 * Returns the block id of today's daily note. App.tsx is responsible
 * for the rest of the bootstrap chain (replaceHash, panel-row tx);
 * the resolver intentionally stops here so the same surface can be
 * used to land somewhere that isn't a daily note (e.g. a future
 * "open last panel" plugin) without duplicating the navigation
 * plumbing.
 */
import type { WorkspaceLandingResolver } from '@/extensions/core.ts'
import { getOrCreateDailyNote, todayIso } from './dailyNotes.ts'

export const todayDailyNoteLanding: WorkspaceLandingResolver = async ({
  repo,
  workspaceId,
  freshlyCreated,
}) => {
  const dailyNote = await getOrCreateDailyNote(repo, workspaceId, todayIso())

  if (freshlyCreated) {
    // First-run discoverability: prepend a [[Tutorial]] bullet on the
    // freshly-created daily note so the welcome content is one click
    // away from the landing page. createChild with position={kind:'first'}
    // computes an order_key that lands before any existing children.
    await repo.mutate.createChild({
      parentId: dailyNote.id,
      content: '[[Tutorial]]',
      position: {kind: 'first'},
    })
  }

  return dailyNote.id
}
