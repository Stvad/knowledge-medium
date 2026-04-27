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
import { aliasProp, fromList } from '@/data/properties'
import type { Workspace } from '@/types'
import type { Repo } from '@/data/repo'

// Roam-style daily-page date: "April 26th, 2026". Used as the seed
// block's content AND as one of its aliases, so the user can re-find
// today's page via [[April 26th, 2026]] autocomplete.
const ordinalSuffix = (day: number): string => {
  if (day >= 11 && day <= 13) return 'th'
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

const formatRoamDate = (date: Date): string => {
  const month = date.toLocaleString('en-US', {month: 'long'})
  const day = date.getDate()
  return `${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()}`
}

const formatIsoDate = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const seedDailyPageContent = (repo: Repo, rootBlockId: string, workspaceId: string): void => {
  const today = new Date()
  const dateLabel = formatRoamDate(today)
  const dateIso = formatIsoDate(today)
  repo.create({
    id: rootBlockId,
    workspaceId,
    content: dateLabel,
    properties: fromList(aliasProp([dateLabel, dateIso])),
  })
}

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
      await primeLocalWorkspace(repo, result.workspace)
      await primeLocalMembership(repo, result.member)

      // The RPC has already created an empty seed root block server-side
      // (so reload-driven bootstrap can never find a block-less workspace
      // and soft-lock). Customize it into a Roam/Logseq-style daily page:
      // today's date as both the content and an alias, so the user can
      // immediately start typing AND re-find this page via
      // [[April 26th, 2026]] later. repo.create with the known id is an
      // upsert — it overwrites whatever's there whether or not sync has
      // already delivered the empty seed.
      seedDailyPageContent(repo, result.rootBlockId, result.workspace.id)
      await repo.flush()
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
