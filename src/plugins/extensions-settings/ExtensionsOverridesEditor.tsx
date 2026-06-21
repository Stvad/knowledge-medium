/**
 * Property editor for `extensions:overrides`.
 *
 * Renders inside the property panel of the Extensions prefs block.
 * Composes:
 *   - `useToggleTree()` — walks the full extension tree (static +
 *     dynamic) into a discoverable forest
 *   - `<ExtensionsSettings>` — the presentational checkbox tree
 *   - `applyToggle` + `onChange` — the property-panel infrastructure
 *     handles the `tx.setProperty` write of the synced INTENT map
 *
 * Two-layer enable model (issue #67): the synced overrides map is the
 * cross-device INTENT; whether a user extension actually runs is gated by
 * a device-local TRUST grant (an approval pinned to the source hash).
 *   - enabling a user extension grants device-local trust the FIRST time
 *     (approves the live source) and sets intent true. If it was already
 *     approved, the existing pin is kept — a since-synced source change
 *     surfaces as "update-available", never auto-adopted on a checkbox
 *     click.
 *   - disabling only flips intent off; the trust grant persists, so
 *     re-enabling is frictionless and still pinned. Disable propagates
 *     across devices through the intent gate alone.
 *   - "Enable here" (approved nowhere here yet) / "Update" (source drifted)
 *     are the EXPLICIT trust actions — they always (re-)approve the live
 *     source, then dispatch a refresh so the loader re-resolves.
 * System (built-in) toggles are intent-only.
 */

import {useCallback} from 'react'
import type {PropertyEditorProps} from '@/data/api'
import {useRepo} from '@/context/repo.js'
import {
  approveExtension,
  readApproval,
} from '@/extensions/compileExtensionModule.js'
import {refreshAppRuntime} from '@/facets/runtimeEvents.js'
import {applyToggle, type Overrides, type Togglable} from '@/facets/togglable.js'
import {ExtensionsSettings} from './ExtensionsSettings.tsx'
import {useToggleTree} from './useToggleTree.ts'

export const ExtensionsOverridesEditor = ({
  value,
  onChange,
}: PropertyEditorProps<Overrides>) => {
  const repo = useRepo()
  const {tree, loading, workspaceId} = useToggleTree()

  // Approve (or re-approve) a user extension on THIS device: pin the live
  // source so the loader will run it. The EXPLICIT trust action, shared by
  // "Enable here" (cross-device) and "Update" (source drifted).
  const approveHere = useCallback(
    async (handle: Togglable) => {
      const block = await repo.load(handle.id)
      if (!block) return
      await approveExtension(handle.id, block.content ?? '')
    },
    [repo],
  )

  const handleToggle = useCallback(
    (handle: Togglable, nextState: boolean) => {
      void (async () => {
        // First-time enable grants device-local trust; a subsequent enable
        // keeps the existing pin (drift shows as update-available rather
        // than being silently adopted). Disabling never touches the pin.
        if (handle.kind === 'user' && nextState && !(await readApproval(handle.id))) {
          await approveHere(handle)
        }
        onChange(applyToggle(value, handle, nextState))
      })()
    },
    [approveHere, onChange, value],
  )

  // Affordance path: intent is already true, so only the approval changes —
  // dispatch a refresh so the loader re-resolves and the pinned version
  // starts running / updates.
  const handleApprove = useCallback(
    (handle: Togglable) => {
      void (async () => {
        await approveHere(handle)
        refreshAppRuntime()
      })()
    },
    [approveHere],
  )

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading extensions…</p>
  }

  return (
    <ExtensionsSettings
      tree={tree}
      overrides={value}
      onToggle={handleToggle}
      onApprove={handleApprove}
      workspaceId={workspaceId}
    />
  )
}
