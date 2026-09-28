/**
 * Web-archive preferences.
 *
 * Every one of these lives on the plugin's own prefs sub-block
 * (`pluginPrefsExtension`), so they sync per user, are editable in
 * Preferences, and a peer plugin's write can't clobber them.
 *
 * `webarchive:enabled` defaults to FALSE and nothing in this plugin reads a
 * URL, let alone sends one, until it is true. Submitting a URL to a public
 * archive publishes the fact that this user visited it — that is a
 * disclosure to a third party, so it is a decision the user makes, not one
 * they discover after the fact.
 */

import { ChangeScope, seedProperty, seedType, type BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { getPluginPrefsBlock, pluginPrefsBlockId } from '@/data/stateBlocks.js'

export const WEB_ARCHIVE_PREFS_TYPE = 'webarchive-prefs'

/** THE opt-in. Off until the user turns it on, on every device, always. */
export const archiveEnabledProp = seedProperty({
  seedKey: 'system:web-archive/property/enabled',
  revision: 1,
  name: 'webarchive:enabled',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})

/** Hosts the user never wants published. Matches the host itself and any
 *  subdomain of it; `*.example.com` matches subdomains only. */
export const archiveDenylistProp = seedProperty({
  seedKey: 'system:web-archive/property/denylist',
  revision: 1,
  name: 'webarchive:denylist',
  preset: 'string-list',
  defaultValue: [],
  changeScope: ChangeScope.UserPrefs,
})

/** Hard ceiling on submissions in any rolling hour. Reached → the plugin
 *  stops submitting and lets the backlog wait; nothing is dropped. */
export const archiveHourlyLimitProp = seedProperty({
  seedKey: 'system:web-archive/property/hourly-limit',
  revision: 1,
  name: 'webarchive:hourlyLimit',
  preset: 'number',
  defaultValue: 60,
  changeScope: ChangeScope.UserPrefs,
})

/** Hard ceiling on submissions in any rolling 24h. */
export const archiveDailyLimitProp = seedProperty({
  seedKey: 'system:web-archive/property/daily-limit',
  revision: 1,
  name: 'webarchive:dailyLimit',
  preset: 'number',
  defaultValue: 500,
  changeScope: ChangeScope.UserPrefs,
})

/** Soft threshold: crossing this many submissions in a rolling hour raises a
 *  toast. Distinct from `hourlyLimit` on purpose — this is "you are
 *  publishing a lot right now, did you mean to?", not a stop. */
export const archiveNotifyThresholdProp = seedProperty({
  seedKey: 'system:web-archive/property/notify-threshold',
  revision: 1,
  name: 'webarchive:notifyThreshold',
  preset: 'number',
  defaultValue: 25,
  changeScope: ChangeScope.UserPrefs,
})

/** Which registered `ArchiveService` to use. */
export const archiveServiceIdProp = seedProperty({
  seedKey: 'system:web-archive/property/service-id',
  revision: 1,
  name: 'webarchive:serviceId',
  preset: 'string',
  defaultValue: 'web.archive.org',
  changeScope: ChangeScope.UserPrefs,
})

export const webArchivePrefsType = seedType({
  seedKey: 'system:web-archive/type/prefs',
  revision: 1,
  id: WEB_ARCHIVE_PREFS_TYPE,
  label: 'Web archive',
  properties: [
    archiveEnabledProp,
    archiveDenylistProp,
    archiveHourlyLimitProp,
    archiveDailyLimitProp,
    archiveNotifyThresholdProp,
    archiveServiceIdProp,
  ],
})

export interface WebArchivePrefs {
  readonly enabled: boolean
  readonly denylist: readonly string[]
  readonly hourlyLimit: number
  readonly dailyLimit: number
  readonly notifyThreshold: number
  readonly serviceId: string
}

/** What a user who has never opened these settings has. Off, and inert. */
export const DEFAULT_PREFS: WebArchivePrefs = {
  enabled: archiveEnabledProp.defaultValue,
  denylist: archiveDenylistProp.defaultValue,
  hourlyLimit: archiveHourlyLimitProp.defaultValue,
  dailyLimit: archiveDailyLimitProp.defaultValue,
  notifyThreshold: archiveNotifyThresholdProp.defaultValue,
  serviceId: archiveServiceIdProp.defaultValue,
}

const decode = <T>(
  data: BlockData,
  prop: {name: string; codec: {decode: (raw: unknown) => T}; defaultValue: T},
): T => {
  const raw = data.properties[prop.name]
  if (raw === undefined) return prop.defaultValue
  try {
    return prop.codec.decode(raw)
  } catch {
    return prop.defaultValue
  }
}

/** Snapshot the prefs off an already-loaded prefs block. */
export const readPrefs = (block: Block): WebArchivePrefs => ({
  enabled: block.get(archiveEnabledProp),
  denylist: block.get(archiveDenylistProp),
  hourlyLimit: block.get(archiveHourlyLimitProp),
  dailyLimit: block.get(archiveDailyLimitProp),
  notifyThreshold: block.get(archiveNotifyThresholdProp),
  serviceId: block.get(archiveServiceIdProp),
})

/** Resolve (creating on first use) and load this user's web-archive prefs
 *  block. Reach for this only from surfaces the user has actually opened —
 *  the settings editor, a test — never from the background paths, which use
 *  `loadPrefs` below. `getPluginPrefsBlock` is memoized per (repo, workspace,
 *  user), so repeat calls are a cache hit and not a transaction. */
export const loadPrefsBlock = async (
  repo: Repo,
  workspaceId: string,
): Promise<Block> => {
  const block = await getPluginPrefsBlock(repo, workspaceId, repo.user, webArchivePrefsType)
  await block.load()
  return block
}

/**
 * Read the preferences WITHOUT creating them.
 *
 * `getPluginPrefsBlock` is get-or-create, so calling it from the processor
 * would mean every first content write in a workspace materializes the user
 * page and the Preferences subtree — inside a post-commit processor, for a
 * feature that is switched off. "Off" should cost nothing and write nothing,
 * so a missing block is read as the defaults, which are off.
 */
export const loadPrefs = async (
  repo: Repo,
  workspaceId: string,
): Promise<WebArchivePrefs> => {
  const data = await repo.load(
    pluginPrefsBlockId(workspaceId, repo.user.id, WEB_ARCHIVE_PREFS_TYPE),
  )
  if (!data) return DEFAULT_PREFS
  return {
    enabled: decode(data, archiveEnabledProp),
    denylist: decode(data, archiveDenylistProp),
    hourlyLimit: decode(data, archiveHourlyLimitProp),
    dailyLimit: decode(data, archiveDailyLimitProp),
    notifyThreshold: decode(data, archiveNotifyThresholdProp),
    serviceId: decode(data, archiveServiceIdProp),
  }
}
