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
 *   - `DailyNotePicker` — the date-picker dialog component, opened on
 *     demand with `openDialog(DailyNotePicker, {anchorRect?, initialIso?})`.
 *   - `isDateAlias(alias)` — shape-only predicate (`YYYY-MM-DD`).
 *   - `isValidDateAlias(alias)` — shape + calendar-validity predicate.
 *     The routing decision in `parseReferences` and SRS's daily-note
 *     ISO extraction use this so calendar-invalid strings
 *     (`2026-13-01`, `2026-02-30`) don't get treated as real dates.
 *   - `DAILY_NOTE_NS`, `JOURNAL_NS` — namespace UUIDs.
 *
 * The `dailyNotesPlugin` AppExtension contributes:
 *   - the three global `open_*_daily_note` actions, and
 *   - a header button that opens the daily-note picker dialog, and
 *   - a `workspaceLandingFacet` resolver that lands the user on
 *     today's note when the panel layout is empty (plus a tutorial
 *     bullet on first-run workspaces).
 *
 * `dailyNotesDataExtension` (in `dataExtension.ts`) contributes the
 * `daily-note` block type as a `seedType` on `typeSeedsFacet`. It's a separate export so
 * `staticDataExtensions.ts` can install it before the React app
 * mounts, alongside the kernel + other data-only plugins.
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import {
  actionContextsFacet,
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  workspaceLandingFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { continuousGestureRecognizersFacet } from '@/extensions/continuousGestures.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { activeWorkspaceIdPreferringHash } from '@/utils/navigation.js'
import { CalendarDays } from 'lucide-react'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import { dailyNotesActions, resolveCurrentDailyNoteIso } from './actions.ts'
import { dailyNotesDataExtension } from './dataExtension.ts'
import { DailyNotePicker } from './DailyNotePicker.tsx'
import { DailyNotePickerHeaderItem } from './HeaderItem.tsx'
import { openDialog } from '@/utils/dialogs.js'
import { todayDailyNoteLanding } from './landing.ts'
import { blockDateAdapterFacet } from './blockDateAdapter.ts'
import { referenceDateAdapter } from './referenceDateAdapter.ts'
import { wikilinkDisplayDecoratorFacet } from '@/plugins/references/markdown/wikilinks/wikilinkDecorator.js'
import { dailyDateWikilinkDecorator } from './wikilinkDateDecorator.ts'
import { DateScrubOverlay } from './DateScrubOverlay.tsx'
import { DateKeyboardScrubController } from './DateKeyboardScrubController.tsx'
import { dateScrubRecognizer } from './dateScrubRecognizer.ts'
import { dateScrubGestureActions } from './dateScrubGestureActions.ts'
import {
  dateScrubActionContext,
  dateScrubActions,
} from './dateScrubActions.ts'
import {
  rescheduleBlockDateAction,
  rescheduleQuickActionItem,
} from './rescheduleAction.ts'
import {
  spreadBlockDateAction,
  spreadBlockDatesAction,
  spreadBlockDatesGroupHeaderEntry,
} from './spreadDatesAction.ts'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.js'
export {
  APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
  OPEN_NEXT_DAILY_NOTE_ACTION_ID,
  OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID,
  OPEN_TODAY_ACTION_ID,
  appendTodayDailyBlockInStack,
  resolveCurrentDailyNoteIso,
} from './actions.ts'
export {
  DailyNotePicker,
  type DailyNotePickerAnchorRect,
  type DailyNotePickerProps,
} from './DailyNotePicker.tsx'

export const OPEN_DAILY_NOTE_PICKER_ACTION_ID = 'open_daily_note_picker'

export const dateScrubOverlayMount: AppMountContribution = {
  id: 'daily-notes.date-scrub-overlay',
  component: DateScrubOverlay,
}

export const dateKeyboardScrubControllerMount: AppMountContribution = {
  id: 'daily-notes.date-keyboard-scrub',
  component: DateKeyboardScrubController,
}

export const dailyNotePickerHeaderItem: HeaderItemContribution = {
  id: 'daily-notes.date-picker-header',
  region: 'start',
  component: DailyNotePickerHeaderItem,
}

// Factory — handler resolves the currently-viewed daily note's ISO
// (via `resolveCurrentDailyNoteIso`) so the picker opens on that
// month with the day pre-selected, matching the header-button path.
// Falls back to `repo.activeWorkspaceId` when the hash hasn't set a
// workspace yet (parity with `openDailyNoteByOffset`).
export const openDailyNotePickerAction = (
  {repo}: {repo: Repo},
): ActionConfig<typeof ActionContextTypes.GLOBAL> => ({
  id: OPEN_DAILY_NOTE_PICKER_ACTION_ID,
  description: 'Open daily note picker',
  context: ActionContextTypes.GLOBAL,
  icon: CalendarDays,
  handler: async () => {
    const workspaceId = activeWorkspaceIdPreferringHash(repo)
    const initialIso = workspaceId
      ? (await resolveCurrentDailyNoteIso(repo, workspaceId)) ?? undefined
      : undefined
    void openDialog(DailyNotePicker, {initialIso})
  },
})

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
// `spreadDatesAction.ts` calls `openDialog(SpreadDatesDialog)`, which
// is inert without DialogHost mounted. Pull the dialog-mount extension
// in here (same as block-tagging) so the host is present whenever any
// dialog-using plugin is enabled. Dedup by FacetContribution reference
// keeps the registry to exactly one appMountsFacet entry.
export const dailyNotesPlugin = ({repo}: {repo: Repo}): AppExtension =>
  systemToggle({
    id: 'system:daily-notes',
    name: 'Daily notes',
    description: 'Date-keyed pages, the workspace-landing resolver that opens today on app open, and the prev/next/today shortcuts.',
  }).of([
    dailyNotesDataExtension,
    dialogAppMountExtension,
    appMountsFacet.of(dateScrubOverlayMount, {source: 'daily-notes'}),
    appMountsFacet.of(dateKeyboardScrubControllerMount, {source: 'daily-notes'}),
    dailyNotesActions({repo}).map(action =>
      actionsFacet.of(action, {source: 'daily-notes'}),
    ),
    actionsFacet.of(rescheduleBlockDateAction, {source: 'daily-notes'}),
    quickActionItemsFacet.of(rescheduleQuickActionItem, {source: 'daily-notes'}),
    actionsFacet.of(spreadBlockDateAction, {source: 'daily-notes'}),
    actionsFacet.of(spreadBlockDatesAction, {source: 'daily-notes'}),
    groupedBacklinksGroupHeaderActionsFacet.of(
      spreadBlockDatesGroupHeaderEntry,
      {source: 'daily-notes'},
    ),
    blockDateAdapterFacet.of(referenceDateAdapter, {source: 'daily-notes'}),
    wikilinkDisplayDecoratorFacet.of(dailyDateWikilinkDecorator, {source: 'daily-notes'}),
    // Two-finger date scrub rides the core continuous-gesture loop now
    // (arbitration + the touch-action / pointer-listener seam live there); the
    // recognizer emits named gestures and the gesture-bound actions below drive
    // the same ScrubHandler/overlay the keyboard path uses.
    continuousGestureRecognizersFacet.of(dateScrubRecognizer, {source: 'daily-notes'}),
    dateScrubGestureActions.map(action =>
      actionsFacet.of(action, {source: 'daily-notes'}),
    ),
    actionContextsFacet.of(dateScrubActionContext, {source: 'daily-notes'}),
    dateScrubActions.map(action =>
      actionsFacet.of(action, {source: 'daily-notes'}),
    ),
    actionsFacet.of(openDailyNotePickerAction({repo}), {source: 'daily-notes'}),
    headerItemsFacet.of(dailyNotePickerHeaderItem, {
      source: 'daily-notes',
      precedence: 5,
    }),
    workspaceLandingFacet.of(todayDailyNoteLanding, {source: 'daily-notes'}),
  ])

export { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType } from './schema.ts'
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
  isValidDateAlias,
  journalBlockId,
  todayIso,
} from './dailyNotes.ts'
export {
  blockDateAdapterFacet,
  pickBlockDateAdapter,
  hasAnyBlockDateAdapter,
  type BlockDateAdapter,
} from './blockDateAdapter.ts'
export { referenceDateAdapter } from './referenceDateAdapter.ts'
export {
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
  rescheduleBlockDateAction,
  rescheduleQuickActionItem,
} from './rescheduleAction.ts'
export {
  SPREAD_BLOCK_DATES_ACTION_ID,
  SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID,
  spreadBlockDateAction,
  spreadBlockDatesAction,
  spreadBlockDatesGroupHeaderEntry,
} from './spreadDatesAction.ts'
export {
  randomUpcomingDateOffset,
  spreadBlockDates,
  type SpreadBlockDatesOptions,
  type SpreadBlockDatesResult,
} from './spreadBlockDates.ts'
export {
  ReschedulePicker,
  type ReschedulePickerAnchorRect,
  type ReschedulePickerProps,
  type ReschedulePickerResult,
} from './ReschedulePicker.tsx'
export {
  DATE_SCRUB_CANCEL_ACTION_ID,
  DATE_SCRUB_COMMIT_ACTION_ID,
  DATE_SCRUB_CONTEXT,
  DATE_SCRUB_DAY_BACKWARD_ACTION_ID,
  DATE_SCRUB_DAY_FORWARD_ACTION_ID,
  DATE_SCRUB_WEEK_BACKWARD_ACTION_ID,
  DATE_SCRUB_WEEK_FORWARD_ACTION_ID,
  ENTER_DATE_SCRUB_ACTION_ID,
  dateScrubActionContext,
  dateScrubActions,
} from './dateScrubActions.ts'
export {
  getDateScrubDraft,
  stageDateScrubDraft,
  type DateScrubDraft,
  type DateScrubDraftPreview,
} from './dateScrubGesture.ts'
