var e=`import { ChangeScope, seedProperty, seedType } from '@/data/api/index.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import type { Repo } from '@/data/repo.js'

const lastSyncProp = seedProperty({
  seedKey: extensionPropertySeedKey('last-synced-at'),
  revision: 1,
  name: 'readwise:lastSyncedAt',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

const readwisePrefsType = seedType({
  // A per-block reserved key the loader binds to this extension block
  // (@extension/type/<key> → <blockId>/type/<key>). Unique within the
  // extension; short, stable, never changed once shipped.
  seedKey: extensionTypeSeedKey('prefs'),
  revision: 1,
  id: 'readwise-prefs',
  label: 'Readwise',
  // Prefs containers are plumbing for the # dropdown, but their
  // chip is informative when the container block itself is on
  // screen — hide completion only (matches the in-repo
  // pluginPrefsExtension stamp).
  hideFromCompletion: true,
  properties: [lastSyncProp],
})

// Read/write the setting from an action handler — NOT at module top level.
// The seeds below only reach the workspace once the runtime resolves this
// module's default export, so a top-level call runs before the type exists.
export const recordSyncTime = async (repo: Repo): Promise<string | undefined> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return undefined
  const prefs = await getPluginPrefsBlock(repo, workspaceId, repo.user, readwisePrefsType)
  const previous = prefs.peekProperty(lastSyncProp)
  await prefs.set(lastSyncProp, new Date().toISOString())
  return previous
}

// Top-level facet contributions:
export default [
  typeSeedsFacet.of(readwisePrefsType, {source: 'readwise'}),
  definitionSeedsFacet.of(lastSyncProp, {source: 'readwise'}),
  // ... actions, mounts, etc.
]
`;export{e as default};
//# sourceMappingURL=userPrefsConfig.js.map