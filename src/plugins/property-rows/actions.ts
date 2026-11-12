/** The two property-display switches as commands, so both are reachable from
 *  the command palette: the WORKSPACE level (this user's default for the
 *  workspace, on their prefs block) and the BLOCK level (the focused or
 *  selected blocks' own children). `Default` clears a level, handing the
 *  decision to the next less specific one. */
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { getPluginPrefsBlock, requireWorkspaceId } from '@/data/stateBlocks'
import {
  parsePropertyDisplaySetting,
  PROPERTY_DISPLAY_MODE_LABELS,
  PROPERTY_DISPLAY_MODES,
  propertyDisplayDefaultProp,
  propertyDisplayPrefsType,
  propertyDisplayProp,
  type PropertyDisplaySetting,
} from '@/data/propertyDisplayMode'
import type { ActionConfig } from '@/shortcuts/types'
import { ActionContextTypes } from '@/shortcuts/types'
import { defineBlocksAction } from '@/shortcuts/utils'

const SETTINGS: readonly PropertyDisplaySetting[] = [...PROPERTY_DISPLAY_MODES, 'inherit']

const settingLabel = (setting: PropertyDisplaySetting): string =>
  setting === 'inherit' ? 'Use the default property display' : PROPERTY_DISPLAY_MODE_LABELS[setting]

const blockSetting = (block: Block): PropertyDisplaySetting =>
  parsePropertyDisplaySetting(block.peek()?.properties[propertyDisplayProp.name])

/** Set the block level on `blocks`. `inherit` is STORED, never unset: on a
 *  child-backed workspace an unset deletes the setting's field row and its
 *  whole subtree, and this scope is not undoable, so content a user had nested
 *  under that row would go with it. */
export const setBlockPropertyDisplay = async (
  blocks: readonly Block[],
  setting: PropertyDisplaySetting,
): Promise<void> => {
  const repo = blocks[0]?.repo
  if (!repo || repo.isReadOnly) return
  await repo.tx(async tx => {
    for (const block of blocks) await tx.setProperty(block.id, propertyDisplayProp, setting)
  }, {scope: ChangeScope.UiState, description: `property display: ${setting}`})
}

export const setWorkspacePropertyDisplay = async (
  repo: Repo,
  setting: PropertyDisplaySetting,
): Promise<void> => {
  const workspaceId = requireWorkspaceId(repo, 'setWorkspacePropertyDisplay')
  const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, propertyDisplayPrefsType)
  await prefs.set(propertyDisplayDefaultProp, setting)
}

const blockActions = SETTINGS.flatMap(setting => {
  const pair = defineBlocksAction({
    id: `property-rows.block.${setting}`,
    blockDescription: `Properties in outline, this block: ${settingLabel(setting)}`,
    blocksDescription: `Properties in outline, selected blocks: ${settingLabel(setting)}`,
    appliesTo: block => blockSetting(block) !== setting,
    flow: blocks => setBlockPropertyDisplay(blocks, setting),
  })
  return [pair.block, pair.blocks]
})

const workspaceActions: ActionConfig<typeof ActionContextTypes.GLOBAL>[] = SETTINGS.map(setting => ({
  id: `property-rows.workspace.${setting}`,
  description: `Properties in outline, my default for this workspace: ${settingLabel(setting)}`,
  context: ActionContextTypes.GLOBAL,
  handler: ({uiStateBlock}) => setWorkspacePropertyDisplay(uiStateBlock.repo, setting),
}))

export const propertyDisplayActions = [...blockActions, ...workspaceActions]
