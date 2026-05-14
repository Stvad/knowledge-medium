/**
 * Daily-notes plugin — owns the workspace's Journal page, the dated
 * pages under it, and the bootstrap behavior of landing on today's
 * daily note when the user opens the app with an empty layout hash.
 *
 * Public surface (stable; other plugins import from here):
 *   - `DAILY_NOTE_TYPE` — block-type id. The plugin contributes the
 *     type via `dailyNotesDataExtension`; SRS uses it to constrain
 *     `srsNextReviewDateProp` ref targets.
 *   - `dailyNoteBlockId(workspaceId, iso)` — deterministic id for a
 *     daily note. Used by the Roam importer and the backlinks
 *     references-processor for date-shaped alias routing.
 *   - `journalBlockId(workspaceId)` — deterministic id for the
 *     workspace's Journal page.
 *   - `todayIso()` / `addDaysIso(iso, days)` — date math used by
 *     keyboard actions and the bootstrap.
 *   - `getOrCreateDailyNote(repo, ws, iso)` /
 *     `getOrCreateJournalBlock(repo, ws)` — idempotent repo mutators.
 *   - `ensureDailyNoteTarget(tx, repo, date, ws, snap?)` — lighter
 *     reference-target materialiser called from the backlinks
 *     references-processor when a date-shaped alias resolves to a
 *     date that has no row yet.
 *   - `isDateAlias(alias)` — date-shape predicate (`YYYY-MM-DD`).
 *   - `DAILY_NOTE_NS`, `JOURNAL_NS` — namespace UUIDs.
 *
 * The `dailyNotesPlugin` AppExtension contributes:
 *   - the three global `open_*_daily_note` actions, and
 *   - a `workspaceLandingFacet` resolver that lands the user on
 *     today's note when the panel layout is empty (plus a tutorial
 *     bullet on first-run workspaces).
 *
 * `dailyNotesDataExtension` (in `dataExtension.ts`) contributes the
 * `daily-note` block type via `typesFacet`. It's a separate export so
 * `staticDataExtensions.ts` can install it before the React app
 * mounts, alongside the kernel + other data-only plugins.
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/extensions/facet.ts'
import { actionsFacet, workspaceLandingFacet } from '@/extensions/core.ts'
import { dailyNotesActions } from './actions.ts'
import { dailyNotesDataExtension } from './dataExtension.ts'
import { todayDailyNoteLanding } from './landing.ts'
export {
  APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
  OPEN_TODAY_ACTION_ID,
} from './actions.ts'

// Factory rather than a const because the action handlers close over
// `repo` (they call `repo.activeWorkspaceId` and `getOrCreateDailyNote`
// without going through React context). Same shape as
// `vimNormalModePlugin({repo})` / `defaultActionsExtension({repo})`.
//
// `dailyNotesDataExtension` is bundled here AND exported separately
// for `staticDataExtensions` (the pre-React Repo bootstrap path).
// AppRuntimeProvider rebuilds the FacetRuntime from `staticAppExtensions`
// alone and calls `repo.setFacetRuntime(...)`, which REPLACES the
// pre-mount registries. Without the data extension here, the
// daily-note TypeContribution disappears after mount and any later
// `getOrCreateDailyNote` / `ensureDailyNoteTarget` throws on
// `repo.addTypeInTx(DAILY_NOTE_TYPE)`. Same pattern as `todoPlugin`,
// `backlinksPlugin`, `srsReschedulingPlugin`.
export const dailyNotesPlugin = ({repo}: {repo: Repo}): AppExtension => [
  dailyNotesDataExtension,
  dailyNotesActions({repo}).map(action =>
    actionsFacet.of(action, {source: 'daily-notes'}),
  ),
  workspaceLandingFacet.of(todayDailyNoteLanding, {source: 'daily-notes'}),
]

export { DAILY_NOTE_TYPE, dailyNoteType } from './schema.ts'
export { dailyNotesDataExtension } from './dataExtension.ts'
export {
  DAILY_NOTE_NS,
  JOURNAL_NS,
  addDaysIso,
  dailyNoteBlockId,
  dailyNoteCreatedAt,
  ensureDailyNoteTarget,
  getOrCreateDailyNote,
  getOrCreateJournalBlock,
  isDateAlias,
  journalBlockId,
  todayIso,
} from './dailyNotes.ts'
