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
import { createEncryptedWorkspace } from '@/sync/keys/flows/createEncryptedWorkspace'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { useRepo } from '@/context/repo'
import type { Workspace } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (workspace: Workspace) => void
}

// How many trailing WK characters the user must retype to confirm they saved
// it (design §8.1). The WK has no recovery, so this is a deliberate friction
// step before the only-shown-once key is dismissed.
const CONFIRM_SUFFIX_LEN = 6

export function CreateWorkspaceDialog({open, onOpenChange, onCreated}: Props) {
  const repo = useRepo()
  const [name, setName] = useState('')
  const [encrypted, setEncrypted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set once an e2ee workspace is created: the dialog switches to the
  // reveal-the-key phase and won't dismiss until the user confirms they saved
  // it. Holds the created workspace so `onCreated` can navigate on confirm.
  const [reveal, setReveal] = useState<{workspace: Workspace; workspaceKey: string} | null>(null)

  const reset = () => {
    setName('')
    setEncrypted(false)
    setError(null)
    setSubmitting(false)
    setReveal(null)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    setSubmitting(true)

    try {
      if (encrypted) {
        // Mints the WK + canary, creates the server row, stores the key, and
        // pins this workspace e2ee. No key bytes reach the server.
        const result = await createEncryptedWorkspace(trimmed, {
          userId: repo.user.id,
          keyStore: getWorkspaceKeyStore(),
          createWorkspace,
        })
        await primeLocalWorkspaceAndMember(repo, result.workspace, result.member)
        // Don't navigate yet — show the key once and require confirmation.
        setReveal({workspace: result.workspace, workspaceKey: result.workspaceKey})
        setSubmitting(false)
        return
      }

      const result = await createWorkspace(trimmed)
      // Plaintext create confirms plaintext (§8.1): pin so first-encounter
      // handling never later quarantines a workspace we created ourselves.
      setModePin(repo.user.id, result.workspace.id, 'plaintext')
      // Optimistically write to local SQLite so the new workspace shows up
      // in the switcher before PowerSync replicates it. We use the canonical
      // member row returned by the RPC (real id) so we don't collide with the
      // row PowerSync will later sync down.
      await primeLocalWorkspaceAndMember(repo, result.workspace, result.member)
      onCreated(result.workspace)
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setSubmitting(false)
    }
  }

  const finishReveal = () => {
    if (!reveal) return
    onCreated(reveal.workspace)
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismissal while the key is being revealed — the user must
        // confirm they saved it (there's no recovery).
        if (!next && reveal) return
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        {reveal ? (
          <RevealWorkspaceKey workspaceKey={reveal.workspaceKey} onConfirm={finishReveal}/>
        ) : (
          <>
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
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={encrypted}
                  onChange={(e) => setEncrypted(e.target.checked)}
                  disabled={submitting}
                />
                <span>
                  <span className="font-medium">End-to-end encrypted</span>
                  <span className="block text-xs text-muted-foreground">
                    Content is encrypted with a key only you hold. You'll get a key to save —
                    there's no recovery if you lose it. Share it out-of-band to collaborate.
                  </span>
                </span>
              </label>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button type="submit" disabled={submitting || !name.trim()}>
                  {submitting
                    ? 'Creating…'
                    : encrypted
                      ? 'Create encrypted workspace'
                      : 'Create workspace'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RevealWorkspaceKey({
  workspaceKey,
  onConfirm,
}: {
  workspaceKey: string
  onConfirm: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')
  const [confirmInput, setConfirmInput] = useState('')

  const suffix = workspaceKey.slice(-CONFIRM_SUFFIX_LEN)
  // Case/whitespace tolerant, mirroring parseWorkspaceKey's leniency.
  const confirmed = confirmInput.trim().toUpperCase() === suffix.toUpperCase()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(workspaceKey)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1500)
    } catch (err) {
      console.error('Clipboard write failed', err)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Save your workspace key</DialogTitle>
        <DialogDescription>
          This is the only time this key is shown. Save it securely — a password manager is
          recommended. There is <span className="font-medium text-foreground">no recovery</span> if
          you lose it: the data becomes permanently unreadable.
        </DialogDescription>
      </DialogHeader>

      <div className="min-w-0 space-y-2 rounded-md border bg-muted/40 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs">{workspaceKey}</code>
          <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={copy}>
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="wk-confirm">
          Confirm you saved it — retype the last {CONFIRM_SUFFIX_LEN} characters
        </Label>
        <Input
          id="wk-confirm"
          autoComplete="off"
          autoFocus
          placeholder={suffix.replace(/./g, '•')}
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && confirmed) onConfirm() }}
        />
      </div>

      <DialogFooter>
        <Button type="button" disabled={!confirmed} onClick={onConfirm}>
          I've saved it
        </Button>
      </DialogFooter>
    </>
  )
}
