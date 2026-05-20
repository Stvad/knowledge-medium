/**
 * Command-palette / shortcut actions for opening the System Plugins
 * settings dialog. Mirrors the agent-runtime action pattern: dispatch
 * a window event that the mounted dialog listens for.
 */

import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.ts'
import {openSystemPluginsDialogEvent} from './SystemPluginsDialog.tsx'

export const openSystemPluginsSettingsAction: ActionConfig<
  typeof ActionContextTypes.GLOBAL
> = {
  id: 'open_system_plugins_settings',
  description: 'Manage system plugins',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(openSystemPluginsDialogEvent))
  },
}
