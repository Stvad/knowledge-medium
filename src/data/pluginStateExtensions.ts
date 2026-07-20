/** Bundling helpers for plugin-owned prefs / ui-state sub-blocks.
 *
 *  Each plugin that owns a per-user pref sub-block or a per-device
 *  ui-state sub-block declares its container type and registers via one
 *  of the helpers below. The helpers pair the type registration — a
 *  `seedType` (which materializes a per-workspace backing block; used by
 *  static plugins and, via `extensionTypeSeedKey`, by dynamic extensions),
 *  or a plain `TypeContribution` on the static `typesFacet` for a caller
 *  that still passes a bare `defineBlockType` (see
 *  `hiddenPluginTypeContribution`) — with an idle-time eager-bootstrap
 *  `AppEffect` so the
 *  sub-block exists before the user navigates to the Preferences /
 *  ui-state tree — without this, plugin sub-blocks would only appear
 *  after their hooks run for the first time, making configurable
 *  options non-discoverable.
 */

import type { TypeContribution } from '@/data/api'
import { typeSeedsFacet, typesFacet } from '@/data/facets.js'
import { isTypeSeedDeclaration, type TypeSeedDeclaration } from '@/data/typeSeeds.js'
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { getPluginPrefsBlock, getPluginUIStateBlock } from '@/data/stateBlocks.js'
import { scheduleDeepIdle, LAZY_DEEP_IDLE } from '@/utils/scheduleIdle.js'

// These sub-blocks only need to exist before the user navigates to Preferences /
// the ui-state tree (and a hook lazily creates them on first use anyway), so the
// eager bootstrap is pure convenience — defer it to genuine idle, never near boot.
const pluginPrefsBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-prefs.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleDeepIdle(() => {
      void getPluginPrefsBlock(repo, workspaceId, repo.user, type)
    }, LAZY_DEEP_IDLE)
  },
})

const pluginUIStateBootstrapEffect = (type: TypeContribution): AppEffect => ({
  id: `plugin-ui-state.${type.id}.bootstrap`,
  start: ({repo, workspaceId}) => {
    scheduleDeepIdle(() => {
      void getPluginUIStateBlock(repo, workspaceId, repo.user, type)
    }, LAZY_DEEP_IDLE)
  },
})

/** Register the container type, hidden from `#` completion. Prefs/ui-state
 *  containers are plumbing for the # dropdown (never offer to tag a block
 *  "Backlinks prefs") — but their chip is informative when the container block
 *  itself is on screen, so ONLY completion is hidden, forced here regardless of
 *  what the caller declared. A `seedType` is routed to `typeSeedsFacet` so it
 *  materializes a per-workspace backing block — for static plugins, and for
 *  dynamic extensions too (they build a block-scoped `seedKey` via
 *  `extensionTypeSeedKey`, which the loader binds to the extension block). A
 *  plain `TypeContribution` (a caller still passing a bare `defineBlockType`)
 *  falls back to the static `typesFacet`. Forcing `hideFromCompletion`
 *  preserves a `TypeSeedDeclaration`'s `seedKey`/`revision`, so the spread
 *  result is still a valid seed. */
const hiddenPluginTypeContribution = (
  type: TypeContribution | TypeSeedDeclaration,
  source: string,
): AppExtension =>
  isTypeSeedDeclaration(type)
    ? typeSeedsFacet.of({...type, hideFromCompletion: true}, {source})
    : typesFacet.of({...type, hideFromCompletion: true}, {source})

/** Bundle a plugin-prefs container-type registration with an idle-time
 *  eager-bootstrap effect. Pass a code `seedType` (preferred); a plain
 *  `TypeContribution` is accepted for a dynamic extension that can't seed its
 *  type yet. Spread the returned array into the plugin's `AppExtension`:
 *
 *      export const myPlugin: AppExtension = [
 *        ...pluginPrefsExtension(myPrefsSeedType, 'my-plugin'),
 *        // …other facet contributions…
 *      ]
 */
export const pluginPrefsExtension = (
  type: TypeContribution | TypeSeedDeclaration,
  source: string,
): readonly AppExtension[] => [
  hiddenPluginTypeContribution(type, source),
  appEffectsFacet.of(pluginPrefsBootstrapEffect(type), {source}),
]

/** Same as `pluginPrefsExtension`, for sub-blocks under the root
 *  ui-state subtree (scoped via ChangeScope.UiState — non-undoable but
 *  still synced). */
export const pluginUIStateExtension = (
  type: TypeContribution | TypeSeedDeclaration,
  source: string,
): readonly AppExtension[] => [
  hiddenPluginTypeContribution(type, source),
  appEffectsFacet.of(pluginUIStateBootstrapEffect(type), {source}),
]
