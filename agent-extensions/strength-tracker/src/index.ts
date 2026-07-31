/** Strength-program tracker — operationalises "Strength Plan v2".
 *
 *  The extension augments the outline; it does not run a surface beside it.
 *  A session is ordinary blocks in your daily note, logged by ticking the
 *  built-in todo checkboxes, and what this contributes is:
 *
 *   - the block schema (workout / exercise-entry / layoff / settings types
 *     and their properties), so a logged session is plain queryable data;
 *   - decorations on those blocks — the prescription line under a lift, tap
 *     controls on a set, the tally and Finish under a workout — all computed
 *     from what the blocks say, none of them holding state of their own;
 *   - one action that creates anything: "start a session", which asks what
 *     tonight is and then stamps it;
 *   - a history renderer for the Strength Log page.
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
import {strengthDecorations} from './ui/decorations'
import {StrengthLogRenderer} from './ui/StrengthPageRenderer'
import {startSessionAction} from './ui/startAction'

const source = 'strength-tracker'

export const OPEN_STRENGTH_LOG_ACTION_ID = 'strength.openLog'

const openStrengthLogAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: OPEN_STRENGTH_LOG_ACTION_ID,
  description: 'Strength: open the log',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const page = await getOrCreateStrengthLogPage(repo, workspaceId)
    await navigateFromGlobalCommand(repo, {blockId: page.id, workspaceId})
  },
}

export default [
  dialogAppMountExtension,

  ...STRENGTH_PROPS.map(prop => definitionSeedsFacet.of(prop, {source})),
  ...STRENGTH_TYPES.map(type => typeSeedsFacet.of(type, {source})),

  strengthDecorations,
  blockRenderersFacet.of({id: 'strengthLog', renderer: StrengthLogRenderer}, {source}),

  actionsFacet.of(startSessionAction, {source}),
  actionsFacet.of(openStrengthLogAction, {source}),
]
