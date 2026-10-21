/**
 * Keeps an opt-in, scheduled copy of this device's SQLite database in a folder
 * the user picks, so the browser's local store becomes expendable on desktop.
 *
 * The app's data lives in OPFS, which a browser can delete wholesale with no
 * app-side cause. Everything already uploaded comes back from the server; what
 * does not is what only this device holds — the `row_events` change log with
 * its before/after rows, `command_events`, and any edit still sitting unsent in
 * the upload queue.
 *
 * Nothing is contributed at all where the File System Access API is missing
 * (Firefox, Safari, mobile): there is no way for the user to choose a folder,
 * so the setting would be an option that cannot be taken.
 */
import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {actionsFacet, appEffectsFacet} from '@/extensions/core.js'
import {dialogAppMountExtension} from '@/extensions/dialogAppMount.js'
import {diagnosticsFacet} from '@/plugins/diagnostics/facet.js'
import {openDbMirrorSettingsAction} from './actions.js'
import {dbMirrorDiagnosticSource} from './diagnostics.js'
import {supportsDirectoryMirroring} from './fileSystemAccess.js'
import {dbMirrorEffect} from './schedule.js'

export const dbMirrorPlugin: AppExtension = supportsDirectoryMirroring()
  ? systemToggle({
      id: 'system:db-mirror',
      name: 'Database mirror',
      description:
        'Keeps a copy of this device’s database in a folder you choose, refreshed while the app is idle, ' +
        'so a browser that clears its local storage cannot take your unsynced work with it.',
    }).of([
      actionsFacet.of(openDbMirrorSettingsAction, {source: 'db-mirror'}),
      appEffectsFacet.of(dbMirrorEffect, {source: 'db-mirror'}),
      diagnosticsFacet.of(dbMirrorDiagnosticSource, {source: 'db-mirror'}),
      dialogAppMountExtension,
    ])
  : null

export {OPEN_DB_MIRROR_SETTINGS_ACTION_ID} from './diagnostics.js'
