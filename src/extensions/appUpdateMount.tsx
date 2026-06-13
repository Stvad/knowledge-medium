/**
 * App-mount that surfaces "a new version is available" as a persistent
 * toast with a Reload action. Pairs with the dot + actionable row on the
 * sync-status chip (src/plugins/sync-status) — the toast is the loud,
 * dismissible nudge; the chip is the quiet, always-there fallback once the
 * toast is gone.
 *
 * We never reload on our own (see src/registerServiceWorker.ts): the new
 * build is already active in the background, so Reload — or any manual
 * reload — lands on it. The toast uses `duration: Infinity` so it waits for
 * the user instead of auto-dismissing, and a stable id so repeated SW
 * detections never stack.
 *
 * Distinct from the `update-indicator` plugin, which flags per-block
 * content edited by another user — this one is about the app build itself.
 */
import { useEffect } from 'react'
import { appUpdate, useAppUpdateAvailable } from '@/appUpdate.js'
import { dismissToast, showInfo } from '@/utils/toast.js'
import { appMountsFacet } from './core.ts'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'

const UPDATE_TOAST_ID = 'app-update-available'

const AppUpdatePrompt = () => {
  const available = useAppUpdateAvailable()
  useEffect(() => {
    if (!available) return
    showInfo('A new version is available.', {
      id: UPDATE_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      action: {label: 'Reload', onClick: () => appUpdate.reload()},
    })
    return () => dismissToast(UPDATE_TOAST_ID)
  }, [available])
  return null
}

export const appUpdatePromptExtension: AppExtension = systemToggle({
  id: 'system:app-update-prompt',
  name: 'App update prompt',
  description: 'Toast prompting a reload when a newer app build has been deployed.',
}).of([
  appMountsFacet.of(
    {id: 'core.app-update-prompt', component: AppUpdatePrompt},
    {source: 'core'},
  ),
])
