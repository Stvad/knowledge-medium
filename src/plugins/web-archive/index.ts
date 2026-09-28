/**
 * Web archive — submit links written in notes to a public web archive, and
 * keep the archived copy next to the original.
 *
 * TWO gates, deliberately. Disabling the plugin removes the machinery;
 * `webarchive:enabled` (default false) is the user's consent to publish. The
 * plugin being present is not consent, so installing, enabling, or syncing it
 * to a new device never starts sending anything on its own.
 *
 * Shape:
 *   processor  notices a public URL in a block → writes a `pending` record
 *              block under it (`processor.ts`, `snapshots.ts`)
 *   drain loop submits pending records at a polite rate, then reads the
 *              archived copy back and records the verified URL (`queue.ts`)
 *   policy     decides what may leave the device at all (`hostPolicy.ts`)
 *   seam       `ArchiveService` — the Wayback implementation is one
 *              contribution to `archiveServicesFacet`, not a hard-wired call
 */

import { propertyEditorOverridesFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { webArchiveDataExtension } from './dataExtension.ts'
import { webArchiveDrainExtension } from './queue.ts'
import { webArchiveConsentUi } from './propertyEditorOverride.ts'

export const webArchivePlugin: AppExtension = systemToggle({
  id: 'system:web-archive',
  name: 'Web archive',
  description:
    'Optionally submits links you save to a public web archive and stores the ' +
    'archived copy alongside the original. Off until you opt in — submitting a ' +
    'URL publishes the fact that you visited it.',
}).of([
  webArchiveDataExtension,
  webArchiveDrainExtension,
  propertyEditorOverridesFacet.of(webArchiveConsentUi, {source: 'web-archive'}),
])

export {
  ARCHIVE_SNAPSHOT_TYPE,
  archiveSnapshotType,
  type ArchiveStatus,
} from './schema.ts'
export {
  WEB_ARCHIVE_PREFS_TYPE,
  archiveEnabledProp,
  webArchivePrefsType,
} from './prefs.ts'
export {
  archiveServicesFacet,
  createWaybackService,
  type ArchiveService,
  type ArchiveSubmission,
} from './service.ts'
