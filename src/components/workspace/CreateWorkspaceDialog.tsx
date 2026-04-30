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
import { createWorkspace, primeLocalWorkspaceAndMember } from '@/data/workspaces'
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
      const result = await createWorkspace(trimmed)
      // Optimistically write to local SQLite so the new workspace shows up
      // in the switcher before PowerSync replicates it. We use the
      // canonical member row returned by the RPC (real id) so we don't
      // collide with the row PowerSync will later sync down.
      await primeLocalWorkspaceAndMember(repo, result.workspace, result.member)

      // No daily-note seed here: navigateToWorkspace updates the hash,
      // App.tsx re-runs getInitialBlock for the new workspace, and
      // getOrCreateDailyNote creates today's note client-side. Doing
      // it again here would just race with that path.
      /* repo.flush dropped — no write queue in new layer */
      onCreated(result.workspace)
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
