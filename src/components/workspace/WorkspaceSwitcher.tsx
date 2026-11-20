import { useCallback, useState } from 'react'
import { ChevronDown, Eye, Plus, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkspaces, useMyWorkspaceRoles, useActiveWorkspaceId } from '@/hooks/useWorkspaces'
import { useRepo } from '@/context/repo'
import { useHash } from 'react-use'
import { buildAppHash } from '@/utils/routing'
import { forgetRememberedWorkspace, recallRememberedWorkspace } from '@/utils/lastWorkspace'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WorkspaceSettingsDialog } from '@/components/workspace/WorkspaceSettingsDialog'
import { useIsLocalOnly } from '@/components/Login'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Workspace } from '@/types'

/** The switcher on a screen standing in for a workspace that isn't open (the
 *  key gate). It names that workspace rather than the active one, offers its
 *  settings beside the trigger — rename, members and delete need no key — and
 *  leaves it through `onLeave`. */
export interface SwitcherGate {
  readonly workspaceId: string
  /** Re-resolve the app away from the workspace. A hash change can't: a gate
   *  never normalizes the hash, so it is often empty already. */
  readonly onLeave: () => void
}

export function WorkspaceSwitcher({
  triggerClassName,
  gate,
}: {
  triggerClassName?: string
  gate?: SwitcherGate
} = {}) {
  const repo = useRepo()
  // useHash listens for `hashchange` (which `useLocation` does not). That's
  // what makes a hash assignment alone enough to re-render — no page reload
  // needed when switching workspaces. `useActiveWorkspaceId` (the read side)
  // is built on the same subscription; we still need `setHash` to navigate.
  const [, setHash] = useHash()
  const activeWorkspaceId = useActiveWorkspaceId()
  const currentWorkspaceId = gate?.workspaceId ?? activeWorkspaceId
  const {workspaces} = useWorkspaces()
  const {rolesByWorkspaceId} = useMyWorkspaceRoles()
  const localOnly = useIsLocalOnly()
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)
  const displayName = currentWorkspace?.name ?? 'Loading…'
  const currentIsViewer = currentWorkspaceId
    ? rolesByWorkspaceId.get(currentWorkspaceId) === 'viewer'
    : false
  const canOpenSettings = currentWorkspace !== undefined && !localOnly

  const navigateToWorkspace = useCallback((workspace: Workspace) => {
    if (workspace.id === currentWorkspaceId) return
    // Flip repo.activeWorkspaceId BEFORE the hash change. App.tsx's
    // getInitialLayout will set it again once it finishes resolving the
    // new workspace, but that path is async (workspace lookup +
    // optional remote-access RPC + daily-note materialisation), and
    // anything that reads `repo.activeWorkspaceId` synchronously in
    // the meantime — the global Roam-import shortcut, search, etc. —
    // would otherwise see the previous workspace and act on it. The
    // user's click is unambiguous intent; reflect it in repo state
    // immediately so consumers don't lag behind the URL.
    repo.setActiveWorkspaceId(workspace.id)
    // App.tsx subscribes through the panel layout projection; updating the
    // hash triggers a re-resolve of getInitialLayout for the new workspace.
    // The new workspace's root block id isn't known here (it may not even
    // be local yet for a just-joined workspace), so we navigate without a
    // block id and let App.tsx's bootstrap fill it in once resolved.
    setHash(buildAppHash(workspace.id))
  }, [currentWorkspaceId, repo, setHash])

  const handleDeleted = useCallback(() => {
    // The deleted workspace must NOT come back as the "remembered" default —
    // forget it before emptying the hash, so App.tsx's bootstrap falls through
    // to another one. Only it: behind a gate the remembered one is usually
    // another workspace, since a locked one is never remembered.
    if (currentWorkspaceId && recallRememberedWorkspace() === currentWorkspaceId) forgetRememberedWorkspace()
    setHash('')
    gate?.onLeave()
  }, [currentWorkspaceId, gate, setHash])

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent transition-colors max-w-[14rem]',
            triggerClassName,
          )}
          aria-label="Switch workspace"
        >
          <span className="truncate">{displayName}</span>
          {currentIsViewer && (
            <Eye
              className="h-3.5 w-3.5 shrink-0 opacity-70"
              aria-label="Read-only"
            />
          )}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
          Workspaces
        </DropdownMenuLabel>
        {workspaces.map((w) => {
          const isViewer = rolesByWorkspaceId.get(w.id) === 'viewer'
          return (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => navigateToWorkspace(w)}
              className={w.id === currentWorkspaceId ? 'font-medium' : undefined}
            >
              <span className="truncate">{w.name}</span>
              {isViewer && (
                <Eye
                  className="h-3.5 w-3.5 shrink-0 opacity-60"
                  aria-label="Read-only"
                />
              )}
              {w.id === currentWorkspaceId && (
                <span className="ml-auto text-xs text-muted-foreground">current</span>
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        {!localOnly && (
          <DropdownMenuItem
            // Defer opening the dialog by a tick. Radix DropdownMenu's
            // close-cleanup (releases body inert + pointer-events) and
            // Dialog's mount-setup (re-acquires them) collide if both run
            // synchronously, leaving `pointer-events: none` stuck on body
            // after the dialog closes.
            onSelect={() => { setTimeout(() => setCreateOpen(true), 0) }}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New workspace</span>
          </DropdownMenuItem>
        )}
        {canOpenSettings && (
          <DropdownMenuItem
            onSelect={() => { setTimeout(() => setSettingsOpen(true), 0) }}
          >
            <Settings className="h-3.5 w-3.5" />
            <span>Workspace settings</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      {gate ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {menu}
          {canOpenSettings && (
            <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-3.5 w-3.5"/>
              Workspace settings
            </Button>
          )}
        </div>
      ) : menu}

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(w) => navigateToWorkspace(w)}
      />

      {currentWorkspace && (
        <WorkspaceSettingsDialog
          workspace={currentWorkspace}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onDeleted={handleDeleted}
        />
      )}
    </>
  )
}
