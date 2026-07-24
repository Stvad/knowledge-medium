/** Strength-program tracker — operationalises "Strength Plan v2".
 *
 *  What it contributes:
 *   - the block schema (workout / exercise-entry / layoff / settings types
 *     and their properties) so logged sessions are plain, queryable blocks;
 *   - a renderer for the Strength Log page that hosts tonight's prescription
 *     + fast logging + trends;
 *   - a global action to open (creating on first use) that page;
 *   - the dialog mount the shoulder self-check needs.
 *
 *  The progression engine and the plan parser are pure and unit-tested; this
 *  file is only wiring.
 */

import {actionsFacet, blockRenderersFacet} from '@/extensions/core.js'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets.js'
import {dialogAppMountExtension} from '@/extensions/dialogAppMount.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {navigateFromGlobalCommand} from '@/utils/navigation.js'

import {STRENGTH_PROPS, STRENGTH_TYPES} from './km/schema'
import {getOrCreateStrengthLogPage} from './km/page'
import {StrengthLogRenderer} from './ui/StrengthPageRenderer'

const source = 'strength-tracker'

export const OPEN_STRENGTH_LOG_ACTION_ID = 'strength.openLog'

const openStrengthLogAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: OPEN_STRENGTH_LOG_ACTION_ID,
  description: 'Strength: open tonight\'s session',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const page = await getOrCreateStrengthLogPage(repo, workspaceId)
    await navigateFromGlobalCommand(repo, {blockId: page.id, workspaceId})
  },
  defaultBinding: {keys: 'Control+Shift+l'},
}

export default [
  dialogAppMountExtension,

  ...STRENGTH_PROPS.map(prop => definitionSeedsFacet.of(prop, {source})),
  ...STRENGTH_TYPES.map(type => typeSeedsFacet.of(type, {source})),

  blockRenderersFacet.of({id: 'strengthLog', renderer: StrengthLogRenderer}, {source}),

  actionsFacet.of(openStrengthLogAction, {source}),
]
