/**
 * Command-palette / shortcut action for opening the System Plugins
 * settings. The settings UI itself is a `PropertyEditorOverride`
 * registered on `systemPluginOverridesProp`, so "opening settings"
 * is just navigating to the System Plugins prefs block — the block's
 * property panel renders the toggle tree.
 *
 * The action also sets `showPropertiesProp: true` on the block so
 * the property panel is visible on arrival. Without this, the user
 * lands on a settings block whose content is empty (everything lives
 * in properties) and would have to toggle the panel manually.
 * Scoped UiState so the choice is per-device and doesn't sync.
 */

import {getPluginPrefsBlock} from '@/data/stateBlocks.ts'
import {showPropertiesProp} from '@/data/properties.ts'
import {navigate} from '@/utils/navigation.ts'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.ts'
import {systemPluginsPrefsType} from './config.ts'

export const openSystemPluginsSettingsAction: ActionConfig<
  typeof ActionContextTypes.GLOBAL
> = {
  id: 'open_system_plugins_settings',
  description: 'Manage system plugins',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefsBlock = await getPluginPrefsBlock(
      repo,
      workspaceId,
      repo.user,
      systemPluginsPrefsType,
    )
    await prefsBlock.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefsBlock.id, workspaceId})
  },
}
