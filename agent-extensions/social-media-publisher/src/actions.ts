import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {getPluginPrefsBlock} from '@/data/stateBlocks.js'
import {showPropertiesProp} from '@/data/properties.js'
import {navigate} from '@/utils/navigation.js'

import {openCredentialsDialog} from './CredentialsDialog'
import {updateCredentialHints} from './credentials'
import {publishFromBlock} from './PublishDialog'
import {publisherPrefsType} from './properties'

export const openSettingsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'social-publisher.configure',
  description: 'Social Publisher: open settings',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, publisherPrefsType)
    await updateCredentialHints(repo)
    await prefs.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefs.id, workspaceId})
  },
}

export const credentialsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'social-publisher.credentials',
  description: 'Social Publisher: configure credentials',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}: {uiStateBlock: any}) => {
    await openCredentialsDialog(uiStateBlock.repo)
  },
}

export const publishAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish',
  description: 'Social Publisher: publish focused block children to configured platforms',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'all')
  },
}

export const publishTwitterAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish-twitter',
  description: 'Social Publisher: publish focused block children to X / Twitter',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'twitter')
  },
}

export const publishBlueskyAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish-bluesky',
  description: 'Social Publisher: publish focused block children to Bluesky',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'bluesky')
  },
}

export const publishLessWrongAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'social-publisher.publish-lesswrong',
  description: 'Social Publisher: publish focused block children to LessWrong',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}: {block: any}) => {
    await publishFromBlock(block.repo, block.id, 'lesswrong')
  },
}

export const socialPublisherActions = [
  openSettingsAction,
  credentialsAction,
  publishAction,
  publishTwitterAction,
  publishBlueskyAction,
  publishLessWrongAction,
]
