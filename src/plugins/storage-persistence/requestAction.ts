/**
 * The "Protect" affordance behind the storage-persistence nudge: a global
 * action the chip's dropdown button runs (and the command palette lists). It's
 * the deliberate, user-initiated request — `{force: true}` bypasses the
 * once-per-session boot gate — with a browser-aware result toast, because a
 * `false` on a prompt-less engine (Chromium heuristics) is "not yet", not a
 * hard failure.
 */
import { ShieldCheck } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { showInfo, showSuccess } from '@/utils/toast.js'
import { getPersistenceState, requestPersistentStorage } from '@/requestPersistentStorage.js'
import { REQUEST_PERSISTENCE_ACTION_ID, refreshPersistenceStatus } from './persistenceStatus.js'

const requestPersistenceAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: REQUEST_PERSISTENCE_ACTION_ID,
  description: 'Protect local data (persistent storage)',
  context: ActionContextTypes.GLOBAL,
  icon: ShieldCheck,
  handler: async () => {
    const granted = await requestPersistentStorage({ force: true })
    if (granted) {
      showSuccess("Local data is now protected on this device — it won't be evicted automatically.")
    } else {
      const { permission } = await getPersistenceState()
      if (permission === 'denied') {
        showInfo(
          "Your browser is blocking storage for this site. Re-enable it in the browser's site settings to protect local data.",
        )
      } else {
        showInfo(
          'Your browser will protect this automatically as you keep using the app — or install it (browser menu → Install) to lock it in now.',
        )
      }
    }
    // Reflect whatever changed (granted clears the nudge) without waiting for
    // the next focus check.
    await refreshPersistenceStatus()
  },
}

export const requestPersistenceActionContribution = actionsFacet.of(requestPersistenceAction, {
  source: 'storage-persistence',
})
