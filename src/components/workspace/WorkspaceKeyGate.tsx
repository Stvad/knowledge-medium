import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { confirmPlaintextForSession, setModePin } from '@/sync/keys/modePin'
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
   *  the host can re-materialize + re-resolve the workspace. May be async (the
   *  host awaits a drain); the gate awaits it so a failure resets the button. */
  onResolved: () => void | Promise<void>
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
    try {
      const result = await unlockWorkspaceWithKey({
        userId,
        workspaceId,
        canary: canary ?? '',
        pastedKey: trimmed,
        keyStore: getWorkspaceKeyStore(),
      })
      if (result.ok) {
        // Await — the host's onResolved drains/materializes, which can fail
        // (local DB / decryption). If it rejects, the catch below resets `busy`
        // and surfaces the error instead of leaving the button stuck.
        await onResolved()
        return
      }
      setBusy(false)
      setError(
        result.reason === 'format'
          ? "That doesn't look like a workspace key (expected kmp-wk-1:…)."
          : result.reason === 'storage'
            ? "Your key is correct, but it couldn't be saved on this device (storage may be full or blocked). Try again."
            : "That key doesn't decrypt this workspace's data.",
      )
    } catch (err) {
      // Defensive: never leave the button stuck on "Unlocking…" with no message.
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not unlock this workspace.')
    }
  }

  const confirmPlaintext = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setModePin(userId, workspaceId, 'plaintext')
    } catch (err) {
      // localStorage can't persist the pin (writes blocked / quota) while the
      // rest of the app still works. Fall back to a session-only confirmation so
      // a plaintext user isn't trapped on the gate; it re-quarantines on next
      // load (where storage may have recovered).
      console.warn('[gate] plaintext pin persist failed; confirming for this session only', err)
      confirmPlaintextForSession(userId, workspaceId)
    }
    try {
      // Await — onResolved re-materializes the now-plaintext workspace's staged
      // rows and re-resolves the layout. On a freshly-wiped device that drain can
      // run for a while; keep the button in its busy state (it unmounts with the
      // gate on success) so the click shows progress instead of looking dead.
      await onResolved()
    } catch (err) {
      // Drain/re-resolve failed — recover the button and say why, rather than
      // leaving it stuck mid-"Confirming…" with no recourse.
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not load this workspace.')
    }
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
            <Button type="button" variant="secondary" className="w-full" disabled={busy} onClick={() => void confirmPlaintext()}>
              {busy ? 'Confirming…' : 'This workspace is not encrypted'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
