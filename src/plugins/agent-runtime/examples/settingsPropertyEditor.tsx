import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes, type Action } from '@/shortcuts/types.js'
import {
  ChangeScope, definePropertyEditorOverride, seedProperty, seedType,
  type PropertyEditorProps,
} from '@/data/api/index.js'
import {
  definitionSeedsFacet, propertyEditorOverridesFacet, typeSeedsFacet,
} from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
import { showPropertiesProp } from '@/data/properties.js'
import { navigate } from '@/utils/navigation.js'

// 1. Each setting is its own typed property of the prefs block.
//    ChangeScope.UserPrefs keeps them per-user (sync across the
//    user's devices, not shared with other workspace members).
const autoSyncProp = seedProperty({
  seedKey: extensionPropertySeedKey('auto-sync'),
  revision: 1,
  name: 'readwise:autoSync',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.UserPrefs,
})
const intervalMinutesProp = seedProperty({
  seedKey: extensionPropertySeedKey('interval-minutes'),
  revision: 1,
  name: 'readwise:intervalMinutes',
  preset: 'number',
  defaultValue: 60,
  changeScope: ChangeScope.UserPrefs,
})

const readwisePrefsType = seedType({
  seedKey: extensionTypeSeedKey('prefs'),
  revision: 1,
  id: 'readwise-prefs',
  label: 'Readwise',
  hideFromCompletion: true, // dropdown plumbing; chip stays informative
  properties: [autoSyncProp, intervalMinutesProp],
})

// 2. Property-editor overrides — register one per property, each
//    rendered inline in the property panel when the user opens
//    the prefs block. For multi-field settings, you can either
//    register multiple small editors (one per property) or have
//    one editor read `block.peekProperty(other)` to span fields.
const AutoSyncEditor = ({value, onChange}: PropertyEditorProps<boolean>) => (
  <label>
    <input
      type='checkbox'
      checked={value}
      onChange={event => onChange(event.target.checked)}
    />
    Auto-sync
  </label>
)

const autoSyncUi = definePropertyEditorOverride(autoSyncProp, {
  label: 'Auto-sync',
  Editor: AutoSyncEditor,
})

// 3. The 'open settings' action navigates to the prefs block;
//    the property panel renders the Editor inline. No modal.
const openSettings: Action<typeof ActionContextTypes.GLOBAL> = {
  id: 'readwise.configure',
  description: 'Configure Readwise sync',
  context: ActionContextTypes.GLOBAL,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const prefsBlock = await getPluginPrefsBlock(
      repo, workspaceId, repo.user, readwisePrefsType,
    )
    // Force the property panel visible on arrival — the block's
    // own content is usually empty (everything is in properties).
    await prefsBlock.set(showPropertiesProp, true)
    navigate(repo, {target: 'new-panel', blockId: prefsBlock.id, workspaceId})
  },
}

// 4. Wire the contributions.
export default [
  typeSeedsFacet.of(readwisePrefsType, {source: 'readwise'}),
  definitionSeedsFacet.of(autoSyncProp, {source: 'readwise'}),
  definitionSeedsFacet.of(intervalMinutesProp, {source: 'readwise'}),
  propertyEditorOverridesFacet.of(autoSyncUi, {source: 'readwise'}),
  actionsFacet.of(openSettings, {source: 'readwise'}),
]
