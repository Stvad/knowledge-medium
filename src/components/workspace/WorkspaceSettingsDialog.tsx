import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useRepo } from '@/context/repo'
import {
  deleteWorkspace,
  inviteMemberByEmail,
  listWorkspaceMembersWithEmails,
  removeWorkspaceMember,
  renameWorkspace,
  updateWorkspaceMemberRole,
} from '@/data/workspaces'
import type { Workspace, WorkspaceMemberWithEmail, WorkspaceRole } from '@/types'

type InviteRole = Exclude<WorkspaceRole, 'owner'>

const INVITE_ROLES: ReadonlyArray<{value: InviteRole, label: string, hint: string}> = [
  {value: 'editor', label: 'Editor', hint: 'Can read and edit the workspace.'},
  {value: 'viewer', label: 'Viewer', hint: 'Read-only access; UI navigation state stays local to their session.'},
]

const roleSelectClassName =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

interface Props {
  workspace: Workspace
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}

export function WorkspaceSettingsDialog({workspace, open, onOpenChange, onDeleted}: Props) {
  const repo = useRepo()
  const isOwner = workspace.ownerUserId === repo.user.id
  const isViewer = repo.isReadOnly

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Workspace settings</DialogTitle>
          <DialogDescription>{workspace.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          {/* `key={workspace.id}` remounts both subsections when the
              user switches to a different workspace; freshly-mounted
              `useState` initializers do the form-reset job so neither
              subsection needs a setState-in-effect on workspace change. */}
          <RenameSection key={workspace.id} workspace={workspace} disabled={!isOwner} />
          <MembersSection key={workspace.id} workspace={workspace} canManage={isOwner} />
          {isOwner && <DangerSection workspace={workspace} onDeleted={() => { onOpenChange(false); onDeleted() }} />}
          {!isOwner && isViewer && (
            <p className="text-sm text-muted-foreground">
              You have read-only access to this workspace. Edits made locally won't be saved.
            </p>
          )}
          {!isOwner && !isViewer && (
            <p className="text-sm text-muted-foreground">
              Only the workspace owner can rename, invite members, or delete this workspace.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RenameSection({workspace, disabled}: {workspace: Workspace, disabled: boolean}) {
  // Form state resets via `key={workspace.id}` at the call site —
  // switching workspaces remounts this component with fresh state.
  const [name, setName] = useState(workspace.name)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed === workspace.name) return
    setSubmitting(true); setError(null); setInfo(null)
    try {
      await renameWorkspace(workspace.id, trimmed)
      setInfo('Renamed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Label htmlFor="ws-rename">Name</Label>
      <div className="flex gap-2">
        <Input
          id="ws-rename"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled || submitting}
        />
        <Button
          type="submit"
          disabled={disabled || submitting || !name.trim() || name.trim() === workspace.name}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-muted-foreground">{info}</p>}
    </form>
  )
}

function MembersSection({workspace, canManage}: {workspace: Workspace, canManage: boolean}) {
  const repo = useRepo()
  const [members, setMembers] = useState<WorkspaceMemberWithEmail[]>([])
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<InviteRole>('editor')
  const [submitting, setSubmitting] = useState(false)
  const [pendingRoleUserId, setPendingRoleUserId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const refreshMembers = useCallback(async () => {
    try {
      setMembers(await listWorkspaceMembersWithEmails(workspace.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    }
  }, [workspace.id])

  // Fetch-on-mount of an external resource (Supabase RPC). The
  // setState lives behind an `await`, so it doesn't actually cascade
  // synchronously, but the lint rule's heuristic still flags it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshMembers()
  }, [refreshMembers])

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setSubmitting(true); setError(null); setInfo(null)
    try {
      await inviteMemberByEmail(workspace.id, trimmed, inviteRole)
      setInfo(`Invitation sent to ${trimmed} as ${inviteRole}. They'll see it next time they sign in.`)
      setEmail('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite failed')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (userId: string) => {
    setError(null); setInfo(null)
    try {
      await removeWorkspaceMember(workspace.id, userId)
      await refreshMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    }
  }

  const changeRole = async (userId: string, role: WorkspaceRole) => {
    setError(null); setInfo(null); setPendingRoleUserId(userId)
    try {
      await updateWorkspaceMemberRole(workspace.id, userId, role)
      await refreshMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Role change failed')
    } finally {
      setPendingRoleUserId(null)
    }
  }

  const inviteHint = INVITE_ROLES.find((r) => r.value === inviteRole)?.hint

  return (
    <div className="space-y-3">
      <Label>Members</Label>
      <ul className="space-y-1 rounded-md border divide-y">
        {members.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">Just you for now.</li>
        )}
        {members.map((m) => {
          const canEditThisMember =
            canManage && m.role !== 'owner' && m.userId !== repo.user.id
          return (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="truncate flex-1">
                {m.email || <span className="font-mono text-xs text-muted-foreground">{m.userId}</span>}
              </span>
              {canEditThisMember ? (
                <select
                  className={cn(roleSelectClassName, 'h-7 py-0 text-xs uppercase tracking-wide')}
                  value={m.role}
                  disabled={pendingRoleUserId === m.userId}
                  onChange={(e) => void changeRole(m.userId, e.target.value as WorkspaceRole)}
                  aria-label={`Change role for ${m.email || m.userId}`}
                >
                  {INVITE_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              ) : (
                <span className="text-xs uppercase tracking-wide rounded bg-muted px-2 py-0.5">{m.role}</span>
              )}
              {canEditThisMember && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  onClick={() => void remove(m.userId)}
                >
                  Remove
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {canManage && (
        <form onSubmit={invite} className="space-y-2">
          <Label htmlFor="ws-invite">Invite by email</Label>
          <div className="flex gap-2">
            <Input
              id="ws-invite"
              type="email"
              placeholder="someone@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="flex-1"
            />
            <select
              className={roleSelectClassName}
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as InviteRole)}
              disabled={submitting}
              aria-label="Invite role"
            >
              {INVITE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <Button type="submit" disabled={submitting || !email.trim()}>
              {submitting ? 'Sending…' : 'Invite'}
            </Button>
          </div>
          {inviteHint && (
            <p className="text-xs text-muted-foreground">{inviteHint}</p>
          )}
        </form>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && <p className="text-sm text-muted-foreground">{info}</p>}
    </div>
  )
}

function DangerSection({workspace, onDeleted}: {workspace: Workspace, onDeleted: () => void}) {
  const [confirmName, setConfirmName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canDelete = confirmName === workspace.name

  const submit = async () => {
    if (!canDelete) return
    setSubmitting(true); setError(null)
    try {
      await deleteWorkspace(workspace.id)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-destructive/40 p-3">
      <Label className="text-destructive">Delete workspace</Label>
      <p className="text-sm text-muted-foreground">
        This permanently deletes the workspace and all its blocks. To confirm, type the workspace name below.
      </p>
      <Input
        placeholder={workspace.name}
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        disabled={submitting}
      />
      <Button
        variant="outline"
        className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={!canDelete || submitting}
        onClick={() => void submit()}
      >
        {submitting ? 'Deleting…' : 'Delete workspace'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
