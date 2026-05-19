/** Bundling helpers for plugin-owned prefs / ui-state sub-blocks.
 *
 *  Each plugin that owns a per-user pref sub-block or a per-device
 *  ui-state sub-block declares it as a `TypeContribution` and registers
 *  via one of the helpers below. The helpers pair the `typesFacet`
 *  registration with an idle-time eager-bootstrap `AppEffect` so the
 *  sub-block exists before the user navigates to the Preferences /
 *  ui-state tree — without this, plugin sub-blocks would only appear
 *  after their hooks run for the first time, making configurable
 *  options non-discoverable.
 */

import type { TypeContribution } from '@/data/api'
import { typesFacet } from '@/data/facets.ts'
import { appEffectsFacet, type AppEffect } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { getPluginPrefsBlock, getPluginUIStateBlock } from '@/data/stateBlocks.ts'
import { scheduleIdle } from '@/utils/scheduleIdle.ts'

const pluginPrefsBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-prefs.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleIdle(async () => {
      await getPluginPrefsBlock(repo, workspaceId, repo.user, type)
    })
  },
})

const pluginUIStateBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-ui-state.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleIdle(async () => {
      await getPluginUIStateBlock(repo, workspaceId, repo.user, type)
    })
  },
})

/** Bundle a plugin-prefs `TypeContribution` registration with an
 *  idle-time eager-bootstrap effect. Spread the returned array into the
 *  plugin's `AppExtension`:
 *
 *      export const myPlugin: AppExtension = [
 *        ...pluginPrefsExtension(myPrefsType, 'my-plugin'),
 *        // …other facet contributions…
 *      ]
 */
export const pluginPrefsExtension = (
  type: TypeContribution,
  source: string,
): readonly AppExtension[] => [
  typesFacet.of(type, {source}),
  appEffectsFacet.of(pluginPrefsBootstrapEffect(type), {source}),
]

/** Same as `pluginPrefsExtension`, for sub-blocks under the root
 *  ui-state subtree (local-ephemeral, per-device). */
export const pluginUIStateExtension = (
  type: TypeContribution,
  source: string,
): readonly AppExtension[] => [
  typesFacet.of(type, {source}),
  appEffectsFacet.of(pluginUIStateBootstrapEffect(type), {source}),
]
