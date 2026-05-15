/**
 * UI-only extension for the mobile date-UX prototypes (option 2 — long
 * press scrub; option 4+1 — calendar+strip sheet).
 *
 * Lives in its own file so daily-notes/index.ts (which is loaded as part
 * of the static data-extension graph via `referencesProcessor`) doesn't
 * pull in `@/extensions/blockInteraction.ts`. blockInteraction transitively
 * imports `globalState → repoProvider → staticDataExtensions`, which would
 * close a load-time cycle that leaves the surface facets uninitialised.
 *
 * `staticAppExtensions.ts` imports this plugin directly — that path runs
 * after the data-extension graph is settled, so the blockInteraction
 * import is safe here.
 */
import type { AppExtension } from '@/extensions/facet.ts'
import { actionsFacet, appMountsFacet } from '@/extensions/core.ts'
import { blockContentSurfacePropsFacet } from '@/extensions/blockInteraction.ts'
import { quickActionItemsFacet } from '@/plugins/swipe-quick-actions'
import { blockDateAdapterFacet } from './blockDateAdapter.ts'
import { referenceDateAdapter } from './referenceDateAdapter.ts'
import { ReschedulePicker } from './ReschedulePicker.tsx'
import { DateScrubOverlay } from './DateScrubOverlay.tsx'
import { dateScrubContentSurface } from './dateScrubGesture.ts'
import {
  rescheduleBlockDateAction,
  rescheduleQuickActionItem,
} from './rescheduleAction.ts'

export const reschedulePickerMount = {
  id: 'daily-notes.reschedule-picker',
  component: ReschedulePicker,
} as const

export const dateScrubOverlayMount = {
  id: 'daily-notes.date-scrub-overlay',
  component: DateScrubOverlay,
} as const

export const dailyNotesDateUxPlugin: AppExtension = [
  appMountsFacet.of(reschedulePickerMount, {source: 'daily-notes-date-ux'}),
  appMountsFacet.of(dateScrubOverlayMount, {source: 'daily-notes-date-ux'}),
  actionsFacet.of(rescheduleBlockDateAction, {source: 'daily-notes-date-ux'}),
  quickActionItemsFacet.of(rescheduleQuickActionItem, {source: 'daily-notes-date-ux'}),
  blockDateAdapterFacet.of(referenceDateAdapter, {source: 'daily-notes-date-ux'}),
  blockContentSurfacePropsFacet.of(dateScrubContentSurface, {source: 'daily-notes-date-ux'}),
]
