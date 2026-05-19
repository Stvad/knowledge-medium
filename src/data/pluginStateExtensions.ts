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
 *
 *  The bootstrap effect deliberately loads `globalState` via a dynamic
 *  `import()` inside `start`. The static path would otherwise create a
 *  cycle at module-init time: plugin data extensions are loaded by
 *  `staticDataExtensions`, which is loaded by `repoProvider`, which is
 *  loaded by the React `context/repo`, which `globalState` imports for
 *  its hooks. Deferring the resolution to effect-start time sidesteps
 *  that loop without restructuring `globalState`.
 */

import type { TypeContribution } from '@/data/api'
import { typesFacet } from '@/data/facets.ts'
import { appEffectsFacet, type AppEffect } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { scheduleIdle } from '@/utils/scheduleIdle.ts'

const pluginPrefsBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-prefs.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleIdle(async () => {
      const {getPluginPrefsBlock} = await import('@/data/globalState')
      await getPluginPrefsBlock(repo, workspaceId, repo.user, type)
    })
  },
})

const pluginUIStateBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-ui-state.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleIdle(async () => {
      const {getPluginUIStateBlock} = await import('@/data/globalState')
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
): AppExtension => [
  typesFacet.of(type, {source}),
  appEffectsFacet.of(pluginPrefsBootstrapEffect(type), {source}),
]

/** Same as `pluginPrefsExtension`, for sub-blocks under the root
 *  ui-state subtree (local-ephemeral, per-device). */
export const pluginUIStateExtension = (
  type: TypeContribution,
  source: string,
): AppExtension => [
  typesFacet.of(type, {source}),
  appEffectsFacet.of(pluginUIStateBootstrapEffect(type), {source}),
]
