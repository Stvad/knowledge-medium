/** The four global commands: open the lab page, stamp tonight's or last
 *  night's block, and open the import dialog. Modelled on the Strength
 *  Tracker's `openStrengthLogAction` / `startAction.ts` — read-only refuses
 *  before any write, and every navigation goes through `showBlock` so a
 *  vetoed navigation is reported rather than silently discarded.
 */
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {openDialog} from '@/utils/dialogs.js'

import {lastNightWakeDate, tonightWakeDate} from '../km/day'
import {stampNight} from '../km/experiment'
import {findLabPage, getOrCreateLabPage} from '../km/page'
import {ImportDialog} from './ImportDialog'
import {showBlock} from './showBlock'

export const OPEN_LAB_ACTION_ID = 'sleeplab.open'
export const TONIGHT_ACTION_ID = 'sleeplab.tonight'
export const LAST_NIGHT_ACTION_ID = 'sleeplab.lastNight'
export const IMPORT_ACTION_ID = 'sleeplab.import'

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
