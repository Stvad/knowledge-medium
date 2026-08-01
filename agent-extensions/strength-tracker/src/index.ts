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
import {findStrengthLogPage} from './km/page'
import {ensureStrengthHome} from './km/tonight'
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
    // A read-only workspace gets what is already there, and never a write.
    // `ensureStrengthHome` bootstraps through `ChangeScope.BlockDefault`,
    // which a read-only repo rejects — so routing everything through it made
    // this command throw before it navigated, and the history view exists
    // precisely to be read without editing rights. Nothing to navigate TO is
    // the honest outcome when the page has never been made.
    if (repo.isReadOnly) {
      const existing = await findStrengthLogPage(repo, workspaceId)
      if (existing) await navigateFromGlobalCommand(repo, {blockId: existing, workspaceId})
      return
    }
    // The page AND its settings block. Creating only the page left a fresh
    // workspace with nowhere to configure the plan root, the rollover hour,
    // the cadence or the rounding: the settings type is hidden from
    // completion, and `ensureStrengthHome` otherwise runs only when a layoff
    // or an `or`-group choice is recorded — so someone who did neither never
    // got one, and had no way to make one.
    //
    // Here rather than in the renderer, which is where it looks like it
    // belongs: this is an explicit gesture that already creates the page, so
    // one more block alongside it is no surprise, while a mount effect would
    // write from every panel that renders the page, in every tab, including
    // one you merely navigated past. Reading still bootstraps nothing.
    const {pageId} = await ensureStrengthHome(repo, workspaceId)
    await navigateFromGlobalCommand(repo, {blockId: pageId, workspaceId})
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
