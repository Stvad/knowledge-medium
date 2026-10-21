/**
 * The one way into the mirror settings: a global command that opens the
 * dialog. The settings are device-local (a folder handle only means anything
 * on the machine that granted it), so unlike the app's block-backed settings
 * there is no prefs block to navigate to — and the folder picker itself needs
 * the user gesture a dialog button gives it.
 */
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {openDialog} from '@/utils/dialogs.js'
import {HardDriveDownload} from 'lucide-react'
import {DbMirrorSettingsDialog} from './DbMirrorSettingsDialog.js'
import {OPEN_DB_MIRROR_SETTINGS_ACTION_ID} from './diagnostics.js'

export const openDbMirrorSettingsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: OPEN_DB_MIRROR_SETTINGS_ACTION_ID,
  description: 'Mirror database to a folder (backup settings)',
  context: ActionContextTypes.GLOBAL,
  icon: HardDriveDownload,
  handler: () => {
    void openDialog(DbMirrorSettingsDialog)
  },
}
