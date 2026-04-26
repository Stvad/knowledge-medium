import { useMemo, useState } from 'react'
import { ChevronDown, Plus, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkspaces } from '@/hooks/useWorkspaces'
import { useRepo } from '@/context/repo'
import { useLocation } from 'react-use'
import { buildAppHash, parseAppHash } from '@/utils/routing'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WorkspaceSettingsDialog } from '@/components/workspace/WorkspaceSettingsDialog'
import type { Workspace } from '@/types'

const navigateToWorkspace = (workspace: Workspace) => {
  // Switching workspaces is a navigation event. We intentionally reload so the
  // App.tsx bootstrap re-runs with the new workspace id and resolves its root
  // block via the same code path as a cold start.
  window.location.hash = buildAppHash(workspace.id)
  window.location.reload()
}

export function WorkspaceSwitcher() {
  const repo = useRepo()
  const location = useLocation()
  const {workspaces} = useWorkspaces()
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeWorkspaceId = useMemo(() => {
    const {workspaceId} = parseAppHash(location.hash)
    return workspaceId ?? repo.activeWorkspaceId ?? null
  }, [location.hash, repo.activeWorkspaceId])

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const displayName = activeWorkspace?.name ?? 'Loading…'

  const handleDeleted = () => {
    // After delete, drop the URL workspace and reload — App.tsx bootstrap will
    // route to ensure_personal_workspace (which returns the user's next-oldest
    // workspace, or creates a fresh one).
    window.location.hash = ''
    window.location.reload()
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent transition-colors max-w-[14rem]"
            aria-label="Switch workspace"
          >
            <span className="truncate">{displayName}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
            Workspaces
          </DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => navigateToWorkspace(w)}
              className={w.id === activeWorkspaceId ? 'font-medium' : undefined}
            >
              <span className="truncate">{w.name}</span>
              {w.id === activeWorkspaceId && (
                <span className="ml-auto text-xs text-muted-foreground">current</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
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
