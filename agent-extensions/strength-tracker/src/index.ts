/** Strength-program tracker — operationalises "Strength Plan v2".
 *
 *  What it contributes:
 *   - the block schema (workout / exercise-entry / layoff / settings types
 *     and their properties) so logged sessions are plain, queryable blocks;
 *   - a renderer for the Strength Log page that hosts tonight's prescription
 *     + fast logging + trends;
 *   - a global action to open (creating on first use) that page, and one to
 *     convert sessions logged in the extension's first shape;
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
import {migrateLegacyEntries} from './km/store'
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

export const MIGRATE_LEGACY_ACTION_ID = 'strength.migrateLegacyLog'

/** One-shot, but left in the palette rather than run once and deleted: it is
 *  idempotent (an entry that already has set blocks is skipped), and a device
 *  that has not synced the whole log yet would migrate only what it holds —
 *  so being able to run it again, later, on another device, is the point.
 *
 *  Reports to the console: this is an administrative action with a report
 *  worth reading in full (which entries it left alone, and why), not a
 *  one-line outcome that fits in a toast. */
const migrateLegacyLogAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: MIGRATE_LEGACY_ACTION_ID,
  description: 'Strength: migrate sessions logged in the old shape',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const page = await getOrCreateStrengthLogPage(repo, workspaceId)
    const report = await migrateLegacyEntries(repo, page.id)
    console.info('[strength] legacy migration', report)
  },
}

export default [
  dialogAppMountExtension,

  ...STRENGTH_PROPS.map(prop => definitionSeedsFacet.of(prop, {source})),
  ...STRENGTH_TYPES.map(type => typeSeedsFacet.of(type, {source})),

  blockRenderersFacet.of({id: 'strengthLog', renderer: StrengthLogRenderer}, {source}),

  actionsFacet.of(openStrengthLogAction, {source}),
  actionsFacet.of(migrateLegacyLogAction, {source}),
]
