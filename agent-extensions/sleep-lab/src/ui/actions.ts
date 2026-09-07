/** The Sleep Lab commands: open the lab page, stamp tonight's or last
 *  night's block, and open the import dialog — all GLOBAL — plus "start an
 *  experiment here", the one NORMAL_MODE gesture that files a fresh
 *  experiment block where the cursor is, inside the protocol notes, rather
 *  than on the dashboard. Modelled on the Strength Tracker's
 *  `openStrengthLogAction` / `startAction.ts` — read-only refuses before any
 *  write, and every navigation goes through `showBlock` so a vetoed
 *  navigation is reported rather than silently discarded.
 */
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {openDialog} from '@/utils/dialogs.js'

import {lastNightWakeDate, tonightWakeDate} from '../km/day'
import {createExperimentAt, stampNight} from '../km/experiment'
import {findLabPage, getOrCreateLabPage} from '../km/page'
import {ImportDialog} from './ImportDialog'
import {placeAtFocus} from './placement'
import {showBlock} from './showBlock'
import {StartExperimentDialog} from './StartExperimentDialog'

export const OPEN_LAB_ACTION_ID = 'sleeplab.open'
export const TONIGHT_ACTION_ID = 'sleeplab.tonight'
export const LAST_NIGHT_ACTION_ID = 'sleeplab.lastNight'
export const IMPORT_ACTION_ID = 'sleeplab.import'
export const START_EXPERIMENT_ACTION_ID = 'sleeplab.startExperiment'

export const openLabAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: OPEN_LAB_ACTION_ID,
  description: 'Sleep Lab: open',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    // Read-only gets what is already there, never a write: `getOrCreateLabPage`
    // bootstraps through a scope a read-only repo rejects, and the dashboard
    // exists precisely to be read without write access.
    if (repo.isReadOnly) {
      const existing = await findLabPage(repo, workspaceId)
      if (existing) await showBlock(repo, workspaceId, existing, 'the Sleep Lab page is there')
      return
    }
    const page = await getOrCreateLabPage(repo, workspaceId)
    await showBlock(repo, workspaceId, page.id, 'the Sleep Lab page is ready')
  },
}

export const tonightAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: TONIGHT_ACTION_ID,
  description: 'Sleep Lab: tonight',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || repo.isReadOnly) return
    const {nightId} = await stampNight(repo, workspaceId, tonightWakeDate())
    await showBlock(repo, workspaceId, nightId, "tonight's night is ready")
  },
}

export const lastNightAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: LAST_NIGHT_ACTION_ID,
  description: 'Sleep Lab: last night',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || repo.isReadOnly) return
    const {nightId} = await stampNight(repo, workspaceId, lastNightWakeDate())
    await showBlock(repo, workspaceId, nightId, "last night's night is ready")
  },
}

export const importAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: IMPORT_ACTION_ID,
  description: 'Sleep Lab: import watch data',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || repo.isReadOnly) return
    await openDialog(ImportDialog, {repo, workspaceId})
  },
}

/** NORMAL_MODE, not GLOBAL, because the block you are on IS the argument —
 *  same reason the Strength Tracker's `startSessionAction` is NORMAL_MODE.
 *  The protocol lives in the notes, so "here" is the whole point: the Sleep
 *  Lab page's own "Start an experiment" button files on the dashboard
 *  instead (`createExperiment`, `placeOnPage`). */
export const startExperimentHereAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: START_EXPERIMENT_ACTION_ID,
  description: 'Sleep Lab: start an experiment here',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}) => {
    const repo = block.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || repo.isReadOnly) return

    const data = block.peek()
    if (!data) return
    // Loaded rather than peeked — the Strength Tracker's `startAction.ts`
    // loads its children for the same reason: "does this block already hold
    // something" decides between filing beside an empty line and filing
    // under a heading, and children are not on the row itself.
    const children = (await block.children.load()) ?? []
    const placement = placeAtFocus({
      id: data.id,
      parentId: data.parentId,
      content: data.content,
      orderKey: data.orderKey,
      hasChildren: children.some(child => !child.deleted),
      properties: data.properties,
    })

    const spec = await openDialog(StartExperimentDialog)
    if (!spec) return
    const experimentId = await createExperimentAt(repo, placement, spec)
    await showBlock(repo, workspaceId, experimentId, 'the experiment is ready')
  },
}
