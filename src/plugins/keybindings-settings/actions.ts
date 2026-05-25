/**
 * Command-palette action for opening the Keyboard shortcuts settings.
 * The settings UI is a `PropertyEditorOverride` on
 * `keybindingOverridesProp`, so "opening settings" is just navigating
 * to the keybindings prefs block with the property panel forced open.
 *
 * Mirrors `openExtensionsSettingsAction` — same UX, different block.
 */
import {getPluginPrefsBlock} from '@/data/stateBlocks.js'
import {showPropertiesProp} from '@/data/properties.js'
import {navigate} from '@/utils/navigation.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {keybindingsPrefsType} from './config.ts'

export const openKeybindingsSettingsAction: ActionConfig<
  typeof ActionContextTypes.GLOBAL
> = {
  id: 'open_keybindings_settings',
  description: 'Customize keyboard shortcuts',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefsBlock = await getPluginPrefsBlock(
      repo,
      workspaceId,
      repo.user,
      keybindingsPrefsType,
    )
    await prefsBlock.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefsBlock.id, workspaceId})
  },
}
