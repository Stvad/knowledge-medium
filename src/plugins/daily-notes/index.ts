/**
 * Daily-notes plugin — owns the workspace's Journal page, the dated
 * pages under it, and the bootstrap behavior of landing on today's
 * daily note when the user opens the app with an empty layout hash.
 *
 * Public surface (stable; other plugins import from here):
 *   - `dailyNoteBlockId(workspaceId, iso)` — deterministic id for a
 *     daily note. Used by the Roam importer and any plugin that needs
 *     to reference today's note without a Repo read.
 *   - `journalBlockId(workspaceId)` — deterministic id for the
 *     workspace's Journal page.
 *   - `todayIso()` / `addDaysIso(iso, days)` — date math used by
 *     keyboard actions and the bootstrap.
 *   - `getOrCreateDailyNote(repo, ws, iso)` /
 *     `getOrCreateJournalBlock(repo, ws)` — idempotent repo mutators.
 *   - `DAILY_NOTE_NS`, `JOURNAL_NS` — namespace UUIDs pinned by a
 *     supabase migration. Exported so the targets.test parity check can
 *     verify the same namespace is used here, in `src/data/targets.ts`,
 *     and in the server-side deterministic-seed SQL.
 *
 * The `dailyNotesPlugin` AppExtension contributes:
 *   - the three global `open_*_daily_note` actions, and
 *   - a `workspaceLandingFacet` resolver that lands the user on
 *     today's note when the panel layout is empty (plus a tutorial
 *     bullet on first-run workspaces).
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/extensions/facet.ts'
import { actionsFacet, workspaceLandingFacet } from '@/extensions/core.ts'
import { dailyNotesActions } from './actions.ts'
import { todayDailyNoteLanding } from './landing.ts'

// Factory rather than a const because the action handlers close over
// `repo` (they call `repo.activeWorkspaceId` and `getOrCreateDailyNote`
// without going through React context). Same shape as
// `vimNormalModePlugin({repo})` / `defaultActionsExtension({repo})`.
export const dailyNotesPlugin = ({repo}: {repo: Repo}): AppExtension => [
  dailyNotesActions({repo}).map(action =>
    actionsFacet.of(action, {source: 'daily-notes'}),
  ),
  workspaceLandingFacet.of(todayDailyNoteLanding, {source: 'daily-notes'}),
]

export {
  DAILY_NOTE_NS,
  JOURNAL_NS,
  addDaysIso,
  dailyNoteBlockId,
  dailyNoteCreatedAt,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  journalBlockId,
  todayIso,
} from './dailyNotes.ts'
