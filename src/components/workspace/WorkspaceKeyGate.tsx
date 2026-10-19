import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { Repo } from '@/data/repo'
import { fetchWorkspaceConversionState, hasCopiedCiphertext } from '@/data/workspaceConversion'
import type { WorkspaceConversionRead } from '@/sync/keys/conversionState'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { confirmPlaintextForSession, setModePin } from '@/sync/keys/modePin'
import type { WorkspaceEntryResolution } from '@/sync/keys/resolveWorkspaceEntry'
import { unlockWorkspaceWithKey } from '@/sync/keys/flows/unlockWorkspaceWithKey'
import {
  checkServerE2eeEntry,
  resumePinUpgrade,
  upgradeWorkspacePin,
  type PinUpgradeKey,
  type ServerE2eeEntry,
  type UpgradeWorkspacePinResult,
} from '@/sync/keys/flows/upgradeWorkspacePin'

export type GateReason = Extract<WorkspaceEntryResolution, {kind: 'locked'}>['reason']

/** What the gate needs from outside the key layer. */
export interface WorkspaceGateDeps {
  /** Re-materialize the workspace's staged rows (`repo.drainSyncWorkspace`). */
  readonly drainWorkspace: () => Promise<void>
  /** The server's workspace row, read now — `conversion_phase` isn't synced. */
  readonly fetchConversionState: () => Promise<WorkspaceConversionRead>
  readonly hasCopiedCiphertext: () => Promise<boolean>
}

export const workspaceGateDeps = (repo: Repo, workspaceId: string): WorkspaceGateDeps => ({
  drainWorkspace: () => repo.drainSyncWorkspace(workspaceId),
  fetchConversionState: () => fetchWorkspaceConversionState(workspaceId),
  hasCopiedCiphertext: () => hasCopiedCiphertext(repo.db, workspaceId),
})

interface Props {
  userId: string
  workspaceId: string
  workspaceName?: string
  /** key-required: an e2ee pin whose WK is absent here. quarantine: unpinned +
   *  server says none — uncertain (branch b). server-e2ee: the server says e2ee
   *  and the pin doesn't (first encounter, or converted in place).
   *  finishing-upgrade: a pin upgrade a crash interrupted. */
  reason: GateReason
  /** workspaces.wk_canary — needed to validate a pasted WK on key-required. May
   *  be null on a genuinely-plaintext workspace (then only confirm-plaintext can
   *  resolve it). server-e2ee reads the canary from the server instead. */
  canary: string | null
  deps: WorkspaceGateDeps
  /** Called once the gate is resolved and the workspace drained, so the host
   *  re-resolves the layout. The gate awaits it so a failure resets the button. */
  onResolved: () => void | Promise<void>
}

/**
 * §6 rule 3 / §8.2 — the read-only gate shown in place of a workspace whose
 * content can't be rendered yet: an E2EE workspace missing its key, an
 * unverified (never-pinned, server-says-none) workspace, or one the server says
 * is e2ee while this device's pin doesn't. The user resolves it by pasting the
 * out-of-band workspace key, or — only in the quarantine case — by confirming
 * the workspace really is plaintext.
 */
export function WorkspaceKeyGate(props: Props) {
  if (props.reason === 'server-e2ee') return <ServerE2eeGate {...props}/>
  if (props.reason === 'finishing-upgrade') return <FinishingUpgradeGate {...props}/>
  return <KeyPromptGate {...props} reason={props.reason}/>
}

const displayName = (workspaceName: string | undefined): string =>
  workspaceName ? `"${workspaceName}"` : 'This workspace'

function GateCard({title, children}: {title: string; children: ReactNode}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border bg-background p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  )
}

const Explanation = ({children}: {children: ReactNode}) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

function KeyInput({
  busy,
  error,
  pasted,
  onChange,
  onSubmit,
}: {
  busy: boolean
  error: string | null
  pasted: string
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="wk-paste">Workspace key</Label>
      <Input
        id="wk-paste"
        autoFocus
        autoComplete="off"
        placeholder="kmp-wk-1:…"
        value={pasted}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="button" className="w-full" disabled={busy || !pasted.trim()} onClick={onSubmit}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </div>
  )
}

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback

function KeyPromptGate({
  userId,
  workspaceId,
  workspaceName,
  reason,
  canary,
  deps,
  onResolved,
}: Props & {reason: 'key-required' | 'quarantine'}) {
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
        // Await — draining materializes, which can fail (local DB /
        // decryption). If it rejects, the catch below resets `busy` and
        // surfaces the error instead of leaving the button stuck.
        await deps.drainWorkspace()
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
      setError(errorMessage(err, 'Could not unlock this workspace.'))
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
      // Await — the drain re-materializes the now-plaintext workspace's staged
      // rows. On a freshly-wiped device that can run for a while; keep the
      // button in its busy state (it unmounts with the gate on success) so the
      // click shows progress instead of looking dead.
      await deps.drainWorkspace()
      await onResolved()
    } catch (err) {
      // Drain/re-resolve failed — recover the button and say why, rather than
      // leaving it stuck mid-"Confirming…" with no recourse.
      setBusy(false)
      setError(errorMessage(err, 'Could not load this workspace.'))
    }
  }

  const name = displayName(workspaceName)

  return (
    <GateCard title={reason === 'key-required' ? `${name} needs its key` : `${name} isn't verified`}>
      <Explanation>
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
      </Explanation>

      <KeyInput busy={busy} error={error} pasted={pasted} onChange={setPasted} onSubmit={() => void submitKey()}/>

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
    </GateCard>
  )
}

const upgradeFailureMessage = (
  result: Exclude<UpgradeWorkspacePinResult, {ok: true} | {reason: 'refused'}>,
): string => {
  switch (result.reason) {
    case 'format':
      return "That doesn't look like a workspace key (expected kmp-wk-1:…)."
    case 'invalid-key':
      return "That key doesn't decrypt this workspace's data."
    case 'no-stored-key':
      return 'The key saved on this device is incomplete. Paste the workspace key instead.'
    case 'storage':
      return "Your key is correct, but it couldn't be saved on this device (storage may be full or blocked). Try again."
  }
}

/**
 * The server says e2ee and this device's pin doesn't. Whether it may unlock
 * depends on the conversion phase, read from the server on mount and on every
 * "Check again": no device unlocks while the server is sealing — the converting
 * device included — and a device that copied ciphertext is sent to the reset.
 */
function ServerE2eeGate({userId, workspaceId, workspaceName, deps, onResolved}: Props) {
  const [entry, setEntry] = useState<ServerE2eeEntry | null>(null)
  const [checks, setChecks] = useState(0)
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void checkServerE2eeEntry({userId, workspaceId, ...deps})
      .catch((err): ServerE2eeEntry => {
        console.warn('[gate] conversion check failed', err)
        return {kind: 'unavailable'}
      })
      .then(next => { if (!cancelled) setEntry(next) })
    void getWorkspaceKeyStore().get(userId, workspaceId)
      .then(record => { if (!cancelled) setHasStoredKey(record != null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [userId, workspaceId, deps, checks])

  const unlock = async (key: PinUpgradeKey) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await upgradeWorkspacePin({
        userId,
        workspaceId,
        ...deps,
        key,
        keyStore: getWorkspaceKeyStore(),
      })
      if (result.ok) {
        await onResolved()
        return
      }
      setBusy(false)
      if (result.reason === 'refused') setEntry(result.entry)
      else setError(upgradeFailureMessage(result))
    } catch (err) {
      setBusy(false)
      setError(errorMessage(err, 'Could not unlock this workspace.'))
    }
  }

  const name = displayName(workspaceName)
  const checkAgain = (
    <Button
      type="button"
      variant="secondary"
      className="w-full"
      onClick={() => {
        setEntry(null)
        setChecks(n => n + 1)
      }}
    >
      Check again
    </Button>
  )

  if (entry === null) {
    return (
      <GateCard title={`Opening ${name}…`}>
        <Explanation>Checking this workspace's encryption status.</Explanation>
      </GateCard>
    )
  }
  if (entry.kind === 'unavailable') {
    return (
      <GateCard title={`Can't check ${name} right now`}>
        <Explanation>
          This workspace is end-to-end encrypted on the server, and this device has to confirm
          its encryption status before unlocking it. Check your connection and try again.
        </Explanation>
        {checkAgain}
      </GateCard>
    )
  }
  if (entry.kind === 'converting') {
    // On the device running the conversion, this is where its flow resumes.
    return (
      <GateCard title={`${name} is being encrypted`}>
        <Explanation>
          Its owner is converting it to end-to-end encryption. It stays closed on this device
          until that's done. Changes made here meanwhile wait on this device and upload once
          it's unlocked.
        </Explanation>
        {checkAgain}
      </GateCard>
    )
  }
  if (entry.kind === 'copied-ciphertext') {
    return (
      <GateCard title={`This device needs a reset for ${name}`}>
        <Explanation>
          An older version of the app copied encrypted data into this device's local copy of
          the workspace, and unlocking can't repair it. Make sure every change on this device
          has synced and your workspace keys are saved elsewhere, export your local data, then
          reset this device's local data and sign in again.
        </Explanation>
      </GateCard>
    )
  }
  return (
    <GateCard title={`${name} is now end-to-end encrypted`}>
      <Explanation>
        Paste the workspace key you saved (or were sent) to unlock it on this device. It stays
        on this device only.
      </Explanation>
      {entry.offerFinish && (
        <Explanation>
          You own this workspace and its conversion hasn't finished: its attachments still
          need converting. Unlock it here, then finish the conversion.
        </Explanation>
      )}
      <KeyInput
        busy={busy}
        error={error}
        pasted={pasted}
        onChange={setPasted}
        onSubmit={() => {
          const text = pasted.trim()
          if (text) void unlock({kind: 'pasted', text})
        }}
      />
      {hasStoredKey && (
        <Button type="button" variant="secondary" className="w-full" disabled={busy} onClick={() => void unlock({kind: 'stored'})}>
          Unlock with the key saved on this device
        </Button>
      )}
    </GateCard>
  )
}

/** A pin upgrade a crash interrupted after its marker: finish it — upgrade the
 *  pin if it hadn't moved, drain, clear the marker — then re-resolve. */
function FinishingUpgradeGate({userId, workspaceId, workspaceName, deps, onResolved}: Props) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const started = useRef(-1)

  useEffect(() => {
    if (started.current === attempt) return
    started.current = attempt
    void resumePinUpgrade({
      userId,
      workspaceId,
      keyStore: getWorkspaceKeyStore(),
      drainWorkspace: deps.drainWorkspace,
    })
      .then(() => onResolved())
      .catch((err: unknown) => setError(errorMessage(err, 'Could not finish unlocking this workspace.')))
  }, [userId, workspaceId, deps, onResolved, attempt])

  return (
    <GateCard title={`Finishing unlocking ${displayName(workspaceName)}…`}>
      <Explanation>Decrypting this workspace on this device. This can take a while for a large workspace.</Explanation>
      {error && (
        <>
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              setError(null)
              setAttempt(n => n + 1)
            }}
          >
            Try again
          </Button>
        </>
      )}
    </GateCard>
  )
}
