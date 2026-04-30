import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, Eye, Plus, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkspaces, useMyWorkspaceRoles } from '@/hooks/useWorkspaces'
import { useRepo } from '@/context/repo'
import { useHash } from 'react-use'
import { buildAppHash, parseAppHash } from '@/utils/routing'
import { forgetRememberedWorkspace } from '@/utils/lastWorkspace'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WorkspaceSettingsDialog } from '@/components/workspace/WorkspaceSettingsDialog'
import { useIsLocalOnly } from '@/components/Login'
import type { Workspace } from '@/types'

export function WorkspaceSwitcher() {
  const repo = useRepo()
  // useHash listens for `hashchange` (which `useLocation` does not). That's
  // what makes a hash assignment alone enough to re-render — no page reload
  // needed when switching workspaces.
  const [hash, setHash] = useHash()
  const {workspaces} = useWorkspaces()
  const {rolesByWorkspaceId} = useMyWorkspaceRoles()
  const localOnly = useIsLocalOnly()
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeWorkspaceId = useMemo(() => {
    const {workspaceId} = parseAppHash(hash)
    return workspaceId ?? repo.activeWorkspaceId ?? null
  }, [hash, repo.activeWorkspaceId])

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const displayName = activeWorkspace?.name ?? 'Loading…'
  const activeIsViewer = activeWorkspaceId
    ? rolesByWorkspaceId.get(activeWorkspaceId) === 'viewer'
    : false

  const navigateToWorkspace = useCallback((workspace: Workspace) => {
    if (workspace.id === activeWorkspaceId) return
    // App.tsx subscribes to the hash via useHash; updating it triggers a
    // re-resolve of getInitialBlock for the new workspace. The new
    // workspace's root block id isn't known here (it may not even be local
    // yet for a just-joined workspace), so we navigate without a block id
    // and let App.tsx's bootstrap fill it in via writeAppHash once resolved.
    setHash(buildAppHash(workspace.id))
  }, [activeWorkspaceId, setHash])

  const handleDeleted = useCallback(() => {
    // The deleted workspace must NOT come back as the "remembered" default on
    // the next render — clear it before emptying the hash, so App.tsx's
    // bootstrap falls through to ensure_personal_workspace and lands on the
    // user's next-oldest workspace (or creates a fresh one).
    forgetRememberedWorkspace()
    setHash('')
  }, [setHash])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent transition-colors max-w-[14rem]"
            aria-label="Switch workspace"
          >
            <span className="truncate">{displayName}</span>
            {activeIsViewer && (
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
                className={w.id === activeWorkspaceId ? 'font-medium' : undefined}
              >
                <span className="truncate">{w.name}</span>
                {isViewer && (
                  <Eye
                    className="h-3.5 w-3.5 shrink-0 opacity-60"
                    aria-label="Read-only"
                  />
                )}
                {w.id === activeWorkspaceId && (
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
          {activeWorkspace && (
            <DropdownMenuItem
              onSelect={() => { setTimeout(() => setSettingsOpen(true), 0) }}
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Workspace settings</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(w) => navigateToWorkspace(w)}
      />

      {activeWorkspace && (
        <WorkspaceSettingsDialog
          workspace={activeWorkspace}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onDeleted={handleDeleted}
        />
      )}
    </>
  )
}
