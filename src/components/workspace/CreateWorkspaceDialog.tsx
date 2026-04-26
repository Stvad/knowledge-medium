import { FormEvent, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { createWorkspace, primeLocalMembership, primeLocalWorkspace } from '@/data/workspaces'
import { useRepo } from '@/context/repo'
import type { Workspace } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (workspace: Workspace) => void
}

export function CreateWorkspaceDialog({open, onOpenChange, onCreated}: Props) {
  const repo = useRepo()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setName('')
    setError(null)
    setSubmitting(false)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    setSubmitting(true)

    try {
      const workspace = await createWorkspace(trimmed)
      // Optimistically write to local SQLite so the new workspace shows up
      // in the switcher before PowerSync replicates it.
      await primeLocalWorkspace(repo, workspace)
      await primeLocalMembership(repo, {
        id: `bootstrap-${workspace.id}`,
        workspaceId: workspace.id,
        userId: repo.currentUser.id,
        role: 'owner',
        createTime: workspace.createTime,
      })
      // Seed an empty root block for the new workspace. Without this, the
      // bootstrap on the next reload would find the workspace locally but
      // no blocks (and no way to know "this is brand new" vs "blocks are
      // syncing"), so it would poll for 12s and then throw. Creating the
      // root block here makes the workspace immediately usable and the
      // bootstrap path identical to navigating to any other workspace.
      repo.create({workspaceId: workspace.id})
      await repo.flush()
      onCreated(workspace)
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            Workspaces are independent block trees. You start as the owner; invite others via Settings.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              autoFocus
              placeholder="My workspace"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create workspace'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
