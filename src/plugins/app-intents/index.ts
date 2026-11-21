/**
 * App-intents plugin — handles PWA-shortcut, Web Share Target, and
 * `note_taking.new_note_url` boot-time dispatch.
 *
 * Public surface:
 *   - `consumeAppIntent(repo, layoutSessionBlock)` — pure-function
 *     entry point (used by `appIntentsBootstrapEffect` and tests).
 *   - `formatSharedContent` — exported for tests and any future
 *     plugin that wants to format Web Share API payloads the same
 *     way.
 *
 * `appIntentsPlugin` (AppExtension) contributes one `AppEffect`:
 *   - `appIntentsBootstrapEffect` — runs once per workspace mount.
 *     It resolves the layout-session block from the repo's
 *     UI-state, then hands off to `consumeAppIntent`. Effect-scoped
 *     errors are caught by `AppRuntimeProvider`'s effect loop and
 *     logged.
 */
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { consumeAppIntent } from './appIntents.ts'

export {
  consumeAppIntent,
  formatSharedContent,
  __resetAppIntentForTesting,
} from './appIntents.ts'

export const appIntentsBootstrapEffect: AppEffect = {
  id: 'app-intents.bootstrap',
  start: async ({repo, workspaceId}) => {
    const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
    const layoutSessionBlock = await getLayoutSessionBlock(
      uiState,
      repo.activeLayoutSessionId,
    )
    await consumeAppIntent(repo, layoutSessionBlock)
  },
}

export const appIntentsPlugin: AppExtension = systemToggle({
  id: 'system:app-intents',
  name: 'App intents',
  description: 'Bootstrap that dispatches PWA-shortcut / share-target / note-taker URL intents on app open.',
  essential: true,
}).of([
  appEffectsFacet.of(appIntentsBootstrapEffect, {source: 'app-intents'}),
])
