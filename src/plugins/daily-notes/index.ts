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
 *   - `openDailyNotePicker(detail?)` / `openDailyNotePickerEvent` —
 *     reusable UI trigger for the global daily-note date picker.
 *   - `isDateAlias(alias)` — date-shape predicate (`YYYY-MM-DD`).
 *   - `DAILY_NOTE_NS`, `JOURNAL_NS` — namespace UUIDs.
 *
 * The `dailyNotesPlugin` AppExtension contributes:
 *   - the three global `open_*_daily_note` actions, and
 *   - a header button + app mount for the daily-note picker, and
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
import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  workspaceLandingFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { CalendarDays } from 'lucide-react'
import { dailyNotesActions } from './actions.ts'
import { dateReferenceShiftActions } from './dateShift.ts'
import { dailyNotesDataExtension } from './dataExtension.ts'
import { DailyNotePicker } from './DailyNotePicker.tsx'
import { DailyNotePickerHeaderItem } from './HeaderItem.tsx'
import { openDailyNotePicker } from './events.ts'
import { todayDailyNoteLanding } from './landing.ts'
export {
  APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
  OPEN_NEXT_DAILY_NOTE_ACTION_ID,
  OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
  OPEN_TODAY_ACTION_ID,
} from './actions.ts'
export {
  openDailyNotePicker,
  openDailyNotePickerEvent,
  type DailyNotePickerAnchorRect,
  type OpenDailyNotePickerEventDetail,
} from './events.ts'

export const OPEN_DAILY_NOTE_PICKER_ACTION_ID = 'open_daily_note_picker'

export const dailyNotePickerMount: AppMountContribution = {
  id: 'daily-notes.date-picker',
  component: DailyNotePicker,
}

export const dailyNotePickerHeaderItem: HeaderItemContribution = {
  id: 'daily-notes.date-picker-header',
  region: 'end',
  component: DailyNotePickerHeaderItem,
}

export const openDailyNotePickerAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: OPEN_DAILY_NOTE_PICKER_ACTION_ID,
  description: 'Open daily note picker',
  context: ActionContextTypes.GLOBAL,
  icon: CalendarDays,
  handler: () => openDailyNotePicker(),
}

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
  appMountsFacet.of(dailyNotePickerMount, {source: 'daily-notes'}),
  dailyNotesActions({repo}).map(action =>
    actionsFacet.of(action, {source: 'daily-notes'}),
  ),
  dateReferenceShiftActions.map(action =>
    actionsFacet.of(action, {source: 'daily-notes'}),
  ),
  actionsFacet.of(openDailyNotePickerAction, {source: 'daily-notes'}),
  headerItemsFacet.of(dailyNotePickerHeaderItem, {
    source: 'daily-notes',
    precedence: 5,
  }),
  workspaceLandingFacet.of(todayDailyNoteLanding, {source: 'daily-notes'}),
]

export { DAILY_NOTE_TYPE, dailyNoteType } from './schema.ts'
export { dailyNotesDataExtension } from './dataExtension.ts'
export {
  DATE_SHIFT_BACKWARD_DAY_ACTION_ID,
  DATE_SHIFT_BACKWARD_WEEK_ACTION_ID,
  DATE_SHIFT_FORWARD_DAY_ACTION_ID,
  DATE_SHIFT_FORWARD_WEEK_ACTION_ID,
  dateReferenceShiftActions,
  shiftSingleDateReferenceContent,
  shiftSingleDateReferenceForBlock,
  canShiftSingleDateReference,
} from './dateShift.ts'
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
