/**
 * Property editor for `extensions:overrides`.
 *
 * Renders inside the property panel of the Extensions prefs block.
 * Composes:
 *   - `useToggleTree()` — walks the full extension tree (static +
 *     dynamic) into a discoverable forest
 *   - `<ExtensionsSettings>` — the presentational checkbox tree
 *   - `block.set(extensionsOverridesProp, updater)` — a read-modify-write
 *     of the synced INTENT map inside the serialized write-tx, so two
 *     overlapping toggles (whose first-enable approvals run async) can't
 *     each compute from a stale snapshot and drop one another's intent.
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
import type {Block} from '@/data/block.js'
import {useRepo} from '@/context/repo.js'
import {
  approveExtension,
  lookupApproval,
} from '@/extensions/compileExtensionModule.js'
import {refreshAppRuntime} from '@/facets/runtimeEvents.js'
import {applyToggle, type Overrides, type Togglable} from '@/facets/togglable.js'
import {showError} from '@/utils/toast.js'
import {extensionsOverridesProp} from './config.ts'
import {ExtensionsSettings} from './ExtensionsSettings.tsx'
import {useToggleTree} from './useToggleTree.ts'

export const ExtensionsOverridesEditor = ({
  value,
  block,
}: PropertyEditorProps<Overrides>) => {
  const repo = useRepo()
  const {tree, loading, workspaceId} = useToggleTree()
  // `PropertyEditorProps.block` is intentionally `unknown` (the data-layer
  // api avoids importing the Block facade) — narrow it here.
  const prefsBlock = block as Block

  // Approve (or re-approve) a user extension on THIS device: pin the live
  // source so the loader will run it. The EXPLICIT trust action, shared by
  // "Enable here" (cross-device) and "Update" (source drifted). Returns
  // whether trust was established; surfaces a toast on failure so the caller
  // can avoid setting "enabled" intent against a non-existent approval
  // (which would silently loop on needs-approval — #67 review).
  const approveHere = useCallback(
    async (handle: Togglable): Promise<boolean> => {
      const block = await repo.load(handle.id)
      if (!block) {
        showError(`Couldn't enable "${handle.name}" — its definition block wasn't found.`)
        return false
      }
      try {
        await approveExtension(handle.id, block.content ?? '')
        return true
      } catch (error) {
        console.error(`Failed to approve extension ${handle.id}`, error)
        showError(
          `Couldn't enable "${handle.name}" — ${
            error instanceof Error ? error.message : 'approval could not be saved'
          }.`,
        )
        return false
      }
    },
    [repo],
  )

  const handleToggle = useCallback(
    (handle: Togglable, nextState: boolean) => {
      void (async () => {
        // First-time enable grants device-local trust; a subsequent enable
        // keeps the existing pin (drift shows as update-available rather
        // than being silently adopted). Disabling never touches the pin.
        if (handle.kind === 'user' && nextState) {
          const approval = await lookupApproval(handle.id)
          // Fail closed if the store is unreadable: approving here would
          // pin the current (possibly drifted) live source over an existing
          // pin we just couldn't see (#67 review).
          if (approval.status === 'unreadable') {
            showError(
              `Couldn't enable "${handle.name}" — couldn't read its approval state. Try again.`,
            )
            return
          }
          // Only a definitively-absent approval triggers a first-time
          // approve; an existing pin is kept. Don't flip intent on if trust
          // couldn't be established.
          if (approval.status === 'unapproved' && !(await approveHere(handle))) return
        }
        // Read-modify-write inside the serialized write-tx (not against the
        // captured `value` snapshot), so an overlapping toggle whose async
        // approval is still in flight can't drop this one's intent.
        try {
          await prefsBlock.set(extensionsOverridesProp, current =>
            applyToggle(current ?? new Map(), handle, nextState),
          )
        } catch (error) {
          // A failed intent write must surface, not become a silent
          // unhandled rejection that snaps the checkbox back with no reason.
          console.error(`Failed to write extensions intent for ${handle.id}`, error)
          showError(
            `Couldn't ${nextState ? 'enable' : 'disable'} "${handle.name}" — the change couldn't be saved.`,
          )
        }
      })()
    },
    [approveHere, prefsBlock],
  )

  // Affordance path: intent is already true, so only the approval changes —
  // dispatch a refresh (only if it succeeded) so the loader re-resolves and
  // the pinned version starts running / updates.
  const handleApprove = useCallback(
    (handle: Togglable) => {
      void (async () => {
        if (await approveHere(handle)) refreshAppRuntime()
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
