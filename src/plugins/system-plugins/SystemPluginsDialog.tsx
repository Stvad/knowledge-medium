/**
 * Settings dialog that hosts the System Plugins tree.
 *
 * Composes the pieces:
 *   - `useToggleTree()`   — walks the live extension tree
 *   - `useOverrides()`    — exposes the current overrides + refresh
 *                           subscription
 *   - `<SystemPluginsSettings>` — renders the nested checkboxes
 *   - `writeOverridesToBlock()` — persists user clicks back to the
 *                                 System Plugins prefs block
 *
 * Opens via the agent-runtime pattern: a custom event dispatched from
 * the command-palette action toggles a top-level mounted instance.
 */

import {useCallback, useEffect, useState} from 'react'
import {useRepo} from '@/context/repo.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import {appMountsFacet, type AppMountContribution} from '@/extensions/core.ts'
import {useOverrides} from '@/extensions/useOverrides.ts'
import {applyToggle, type Togglable} from '@/extensions/togglable.ts'
import type {AppExtension} from '@/extensions/facet.ts'
import {SystemPluginsSettings} from './SystemPluginsSettings.tsx'
import {useToggleTree} from './useToggleTree.ts'
import {writeOverridesToBlock} from './writeOverridesToBlock.ts'

export const openSystemPluginsDialogEvent = 'system-plugins:open-dialog'

const SystemPluginsDialog = () => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const [open, setOpen] = useState(false)
  const {tree, loading} = useToggleTree()
  const {overrides} = useOverrides(workspaceId)

  useEffect(() => {
    const handle = () => setOpen(true)
    window.addEventListener(openSystemPluginsDialogEvent, handle)
    return () => window.removeEventListener(openSystemPluginsDialogEvent, handle)
  }, [])

  const onToggle = useCallback(
    async (handle: Togglable, nextState: boolean) => {
      if (!workspaceId) return
      const next = applyToggle(overrides, handle, nextState)
      try {
        await writeOverridesToBlock(repo, workspaceId, next)
      } catch (error) {
        console.error('Failed to persist plugin toggle', error)
      }
    },
    [overrides, repo, workspaceId],
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>System plugins</DialogTitle>
          <DialogDescription>
            Toggle individual plugins. Essential plugins are always on.
            Changes apply immediately and sync across devices.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <SystemPluginsSettings
            tree={tree}
            overrides={overrides}
            onToggle={onToggle}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

const systemPluginsDialogMount: AppMountContribution = {
  id: 'system-plugins.settings-dialog',
  component: SystemPluginsDialog,
}

export const systemPluginsDialogMountExtension: AppExtension =
  appMountsFacet.of(systemPluginsDialogMount, {source: 'system-plugins'})
