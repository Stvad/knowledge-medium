import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { unlockWorkspaceWithKey } from '@/sync/keys/flows/unlockWorkspaceWithKey'

interface Props {
  userId: string
  workspaceId: string
  workspaceName?: string
  /** key-required: server says e2ee or an e2ee pin whose WK was wiped (branch a
   *  / locked). quarantine: unpinned + server says none — uncertain (branch b). */
  reason: 'key-required' | 'quarantine'
  /** workspaces.wk_canary — needed to validate a pasted WK. May be null on a
   *  genuinely-plaintext workspace (then only confirm-plaintext can resolve it). */
  canary: string | null
  /** Called after the gate is resolved (WK accepted, or plaintext confirmed) so
   *  the host can re-resolve the workspace and run its bootstrap. */
  onResolved: () => void
}

/**
 * §6 rule 3 / §8.2 — the read-only gate shown in place of a workspace whose
 * content can't be rendered yet: an E2EE workspace missing its key, or an
 * unverified (never-pinned, server-says-none) workspace. The user resolves it
 * by pasting the out-of-band workspace key, or — only in the quarantine case —
 * by confirming the workspace really is plaintext.
 */
export function WorkspaceKeyGate({
  userId,
  workspaceId,
  workspaceName,
  reason,
  canary,
  onResolved,
}: Props) {
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submitKey = async () => {
    const trimmed = pasted.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    const result = await unlockWorkspaceWithKey({
      userId,
      workspaceId,
      canary: canary ?? '',
      pastedKey: trimmed,
      keyStore: getWorkspaceKeyStore(),
    })
    if (result.ok) {
      onResolved()
      return
    }
    setBusy(false)
    setError(
      result.reason === 'format'
        ? "That doesn't look like a workspace key (expected kmp-wk-1:…)."
        : "That key doesn't decrypt this workspace's data.",
    )
  }

  const confirmPlaintext = () => {
    setModePin(userId, workspaceId, 'plaintext')
    onResolved()
  }

  const name = workspaceName ? `"${workspaceName}"` : 'This workspace'

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border bg-background p-6 shadow-sm">
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">
            {reason === 'key-required' ? `${name} needs its key` : `${name} isn't verified`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {reason === 'key-required' ? (
              <>
                Its content is end-to-end encrypted. Paste the workspace key you saved (or were
                sent) to unlock it on this device. It stays on this device only.
              </>
            ) : (
              <>
                We can't confirm whether this workspace is encrypted. If you have a workspace key
                for it, paste it to unlock. Otherwise, if you know it's a plain (unencrypted)
                workspace, you can confirm that below.
              </>
            )}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="wk-paste">Workspace key</Label>
          <Input
            id="wk-paste"
            autoFocus
            autoComplete="off"
            placeholder="kmp-wk-1:…"
            value={pasted}
            disabled={busy}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitKey() }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="button" className="w-full" disabled={busy || !pasted.trim()} onClick={() => void submitKey()}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </div>

        {reason === 'quarantine' && (
          <div className="border-t pt-4">
            <p className="mb-2 text-xs text-muted-foreground">
              No key because it's not encrypted? Confirm to load it as a plain workspace. This
              choice is permanent for this workspace on every device.
            </p>
            <Button type="button" variant="secondary" className="w-full" onClick={confirmPlaintext}>
              This workspace is not encrypted
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
