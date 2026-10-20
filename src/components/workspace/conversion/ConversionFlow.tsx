import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { SavedKeyPrompt, SavedKeyProblem, SaveKeyPrompt } from '@/sync/conversion/conversionKey'
import { FLIP_SETTLED_MS } from '@/sync/conversion/flipAttempts'
import type { BundleFolder } from '@/sync/conversion/bundle/bundleParts'
import type { ConversionSizes, PreflightBlocker } from '@/sync/conversion/preflight'
import type { SealingPass } from '@/sync/conversion/sealingStage'
import type { UpgradeWorkspacePinResult } from '@/sync/keys/flows/upgradeWorkspacePin'
import {
  runConversion,
  type ActiveStage,
  type ConversionFlowDeps,
  type ConversionRunResult,
  type ConversionStatus,
  type ConversionUi,
} from '@/sync/conversion/runConversion'
import {
  Explanation,
  GateCard,
  PASTED_KEY_PROBLEM,
  WorkspaceKeyDisplay,
  WorkspaceKeyField,
} from '@/components/workspace/keyUi'
import type { ConversionUnavailable } from './conversionFlowDeps'
import { ChooseBundleFolderPrompt, ReopenBundleFolderPrompt } from './bundleFolderPrompts'
import { Actions, errorMessage } from './flowUi'
import { useConversionRun, type PromptChannel, type RunState } from './useConversionRun'

interface Props {
  readonly workspaceName: string | null
  /** Why this session can't run a conversion at all, if it can't. */
  readonly unavailable: ConversionUnavailable | null
  readonly makeDeps: (ui: ConversionUi, signal: AbortSignal) => ConversionFlowDeps
  readonly onClose: () => void
}

/**
 * The conversion flow (docs/workspace-e2ee-conversion.md §6.3): one run at a
 * time, each starting from what the server shows. Closing it between runs is
 * always safe; a conversion past the flip carries on from the workspace's gate.
 */
export function ConversionFlow({workspaceName, unavailable, makeDeps, onClose}: Props) {
  const runWith = useCallback(
    (channel: PromptChannel, signal: AbortSignal) => runConversion(makeDeps(conversionUi(channel), signal)),
    [makeDeps],
  )
  const {state, start, cancel} = useConversionRun(runWith)
  const name = workspaceName ? `"${workspaceName}"` : 'this workspace'

  return (
    <GateCard title={`Encrypt ${name} end to end`} wide>
      {unavailable
        ? <UnavailableView why={unavailable} onClose={onClose}/>
        : <FlowBody state={state} start={start} cancel={cancel} onClose={onClose}/>}
    </GateCard>
  )
}

/** Each question the run asks, as the prompt that answers it. */
const conversionUi = (channel: PromptChannel): ConversionUi => ({
  confirmContract: stage => channel.ask<void>((answer, cancel) => (
    <ContractPrompt stage={stage} answer={() => answer()} cancel={cancel}/>
  )),
  confirmPreflight: report => channel.ask<void>((answer, cancel) => (
    <PreflightPrompt sizes={report.sizes} answer={() => answer()} cancel={cancel}/>
  )),
  saveKey: prompt => channel.ask<string>((answer, cancel) => (
    <SaveKeyPromptView prompt={prompt} answer={answer} cancel={cancel}/>
  )),
  enterSavedKey: prompt => channel.ask<string | null>((answer, cancel) => (
    <SavedKeyPromptView prompt={prompt} answer={answer} cancel={cancel}/>
  )),
  chooseBundleFolder: ({reason}) => channel.ask<BundleFolder>((answer, cancel) => (
    <ChooseBundleFolderPrompt reason={reason} answer={answer} cancel={cancel}/>
  )),
  reopenBundleFolder: ({recorded, problem}) => channel.ask<BundleFolder | null>((answer, cancel) => (
    <ReopenBundleFolderPrompt recorded={recorded} problem={problem} answer={answer} cancel={cancel}/>
  )),
  status: status => channel.status(status),
})

function UnavailableView({why, onClose}: {why: ConversionUnavailable; onClose: () => void}) {
  return (
    <>
      <Explanation>
        {why === 'no-server'
          ? 'Converting needs this device signed in and syncing with the server.'
          : "This browser can't make sure the conversion runs in one tab only. Use desktop Chrome or Edge."}
      </Explanation>
      <Actions secondary={{label: 'Close', onClick: onClose}}/>
    </>
  )
}

/** While the flip request is out it may commit whatever this run does next,
 *  so there is nothing for Stop to stop. */
const canStop = (status: ConversionStatus | null): boolean =>
  !(status?.kind === 'flipping' && status.waiting === null)

function FlowBody({state, start, cancel, onClose}: {
  state: RunState
  start: () => void
  cancel: () => void
  onClose: () => void
}) {
  switch (state.kind) {
    case 'idle':
      return (
        <>
          <Explanation>
            Every block's content is encrypted with a new workspace key that only you hold. Block ids,
            links and timestamps stay as they are. This can't be undone once it starts, and every other
            device needs the key afterwards.
          </Explanation>
          <Actions primary={{label: 'Start', onClick: start}} secondary={{label: 'Close', onClick: onClose}}/>
        </>
      )
    case 'running':
      return state.prompt ?? (
        <>
          <StatusView status={state.status}/>
          {canStop(state.status) && <Actions secondary={{label: 'Stop', onClick: cancel}}/>}
        </>
      )
    case 'finished':
      return <ResultView result={state.result} retry={start} onClose={onClose}/>
    case 'cancelled':
      return (
        <>
          <Explanation>
            Stopped. The next run carries on from where the server is. If you saved a workspace key
            during this run, keep it: the conversion goes on under that key.
          </Explanation>
          <Actions primary={{label: 'Run again', onClick: start}} secondary={{label: 'Close', onClick: onClose}}/>
        </>
      )
    case 'failed':
      return (
        <>
          <p className="text-sm text-destructive">{errorMessage(state.error)}</p>
          <Explanation>The next run carries on from where the server is.</Explanation>
          <Actions primary={{label: 'Try again', onClick: start}} secondary={{label: 'Close', onClick: onClose}}/>
        </>
      )
  }
}

const STAGE_INTRO: Record<ActiveStage['kind'], string> = {
  plaintext: 'This run checks the workspace, creates its key, and switches the server to encrypted mode.',
  sealing: 'The server is in encrypted mode, and this run carries the conversion on from where it stopped.',
  cleaning: "The workspace's content is encrypted; this run finishes the cleanup.",
}

function ConfirmCheck({id, checked, onChange, children}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={value => onChange(value === true)} className="mt-0.5"/>
      <Label htmlFor={id} className="text-sm font-normal leading-snug">{children}</Label>
    </div>
  )
}

function ContractPrompt({stage, answer, cancel}: {stage: ActiveStage; answer: () => void; cancel: () => void}) {
  const [closed, setClosed] = useState(false)
  return (
    <>
      <Explanation>{STAGE_INTRO[stage.kind]}</Explanation>
      <Explanation>
        The conversion is safe only while nothing else uses this workspace. Other devices and tabs that
        write to it during the run may have those writes refused.
      </Explanation>
      <ConfirmCheck id="conversion-contract" checked={closed} onChange={setClosed}>
        Every other device and browser tab with this workspace open is closed, and stays closed until
        the conversion finishes.
      </ConfirmCheck>
      <Actions primary={{label: 'Continue', onClick: answer, disabled: !closed}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** The server re-seals every row and keeps history of both versions, plus WAL
 *  (runbook step 6). */
const SERVER_HEADROOM_FACTOR = 6

function PreflightPrompt({sizes, answer, cancel}: {sizes: ConversionSizes; answer: () => void; cancel: () => void}) {
  const [understood, setUnderstood] = useState(false)
  const bundleBytes = sizes.blocksBytes + sizes.historyBytes + sizes.localDbBytes
  return (
    <>
      <Explanation>Ready to convert. What stays readable on the server afterwards:</Explanation>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>the workspace's name (rename it first if it's sensitive);</li>
        <li>how blocks nest and are ordered, who edited them and when, and which are deleted;</li>
        <li>the size of each encrypted value;</li>
        <li>ids derived from names, such as daily-note dates and page aliases.</li>
      </ul>
      <Explanation>
        Server backups keep the old plaintext until they age out. Without the workspace key nobody,
        including you, can read the content again.
      </Explanation>
      <Explanation>
        The recovery bundle will take about {formatBytes(bundleBytes)}: {sizes.blockRows} blocks
        ({formatBytes(sizes.blocksBytes)}), {sizes.historyRows} history rows ({formatBytes(sizes.historyBytes)}) and
        this device's database ({formatBytes(sizes.localDbBytes)}). Pick a folder with room for it.
        The server needs about {formatBytes(sizes.contentBytes * SERVER_HEADROOM_FACTOR)} of free disk while it converts.
      </Explanation>
      <ConfirmCheck id="conversion-residue" checked={understood} onChange={setUnderstood}>
        I understand, there is room for both, and this can't be undone.
      </ConfirmCheck>
      <Actions primary={{label: 'Continue', onClick: answer, disabled: !understood}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

function SaveKeyPromptView({prompt, answer, cancel}: {
  prompt: SaveKeyPrompt
  answer: (typed: string) => void
  cancel: () => void
}) {
  // Shown once: a mismatch asks for the saved copy again, never shows the key again.
  const [revealed, setRevealed] = useState(!prompt.mismatch)
  const [typed, setTyped] = useState('')

  if (revealed) {
    return (
      <>
        <Explanation>
          This is the workspace key. It's shown only this once. Save it in two places, such as a
          password manager and paper. Every other device asks for it, and without it the content
          can't be read again.
        </Explanation>
        <WorkspaceKeyDisplay workspaceKey={prompt.displayed}/>
        <Actions primary={{label: "I've saved it", onClick: () => setRevealed(false)}} secondary={{label: 'Cancel', onClick: cancel}}/>
      </>
    )
  }
  return (
    <>
      <Explanation>Paste or type the key back from where you saved it.</Explanation>
      <WorkspaceKeyField
        id="conversion-key-check"
        value={typed}
        onChange={setTyped}
        onSubmit={() => answer(typed.trim())}
        error={prompt.mismatch
          ? "That isn't the key shown. Check the copy you saved; if it's wrong, cancel and start again for a new key."
          : null}
      />
      <Actions primary={{label: 'Confirm', onClick: () => answer(typed.trim()), disabled: !typed.trim()}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

const SAVED_KEY_PROBLEM: Record<SavedKeyProblem, string> = {
  ...PASTED_KEY_PROBLEM,
  'stored-key-wrong': "The key on this device doesn't unlock the workspace. Paste the key you saved.",
}

function SavedKeyPromptView({prompt, answer, cancel}: {
  prompt: SavedKeyPrompt
  answer: (pasted: string | null) => void
  cancel: () => void
}) {
  const [pasted, setPasted] = useState('')
  return (
    <>
      <Explanation>
        {prompt.context === 'earlier-attempt'
          ? "This device holds the key from an earlier attempt that didn't switch the server over. Paste the copy you saved then: the conversion goes on under that key."
          : 'Paste the workspace key you saved when the conversion started.'}
      </Explanation>
      <WorkspaceKeyField
        id="conversion-saved-key"
        value={pasted}
        onChange={setPasted}
        onSubmit={() => answer(pasted.trim())}
        error={prompt.problem && SAVED_KEY_PROBLEM[prompt.problem]}
      />
      {prompt.context === 'earlier-attempt' && (prompt.canStartOver
        ? (
          <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => answer(null)}>
            I don't have it: make a new key
          </Button>
        )
        : (
          <p className="text-xs text-muted-foreground">
            The earlier attempt may still reach the server, so a new key can be made only{' '}
            {Math.round(FLIP_SETTLED_MS / 60_000)} minutes after it.
          </p>
        ))}
      <Actions primary={{label: 'Continue', onClick: () => answer(pasted.trim()), disabled: !pasted.trim()}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

const statusText = (status: ConversionStatus | null): string => {
  switch (status?.kind) {
    case undefined:
    case 'reading-server':
      return 'Checking the workspace on the server…'
    case 'preflight':
      return 'Checking that the workspace can be converted…'
    case 'flipping':
      return status.waiting
        ? `Waiting for the database to finish other writes (try ${status.waiting.attempt + 1}, in ${Math.max(1, Math.ceil(status.waiting.retryInMs / 1000))} s)…`
        : 'Switching the server to encrypted mode…'
    case 'checking-key':
      return 'Checking the workspace key…'
    case 'taking-bundle':
      return status.progress?.part === 'local-db'
        ? "Copying this device's database into the bundle…"
        : `Writing the recovery bundle (${status.progress?.rows ?? 0} ${status.progress?.part === 'history' ? 'history rows' : 'blocks'}). Keep this tab open.`
    case 'resealing':
      return `Encrypting blocks on the server: ${status.progress?.scanned ?? 0} checked, ${status.progress?.sealed ?? 0} encrypted. Keep this tab open.`
    case 'verifying':
      return `Checking every encrypted block: ${status.progress?.checked ?? 0} checked${status.progress?.repaired ? `, ${status.progress.repaired} repaired` : ''}.`
    case 'checking-bundle':
      return 'Checking the recovery bundle once more…'
    case 'purging':
      return "Deleting the server's plaintext history…"
    case 'upgrading-pin':
      return 'Decrypting the workspace on this device…'
  }
}

function StatusView({status}: {status: ConversionStatus | null}) {
  return <p className="text-sm" role="status">{statusText(status)}</p>
}

const BLOCKER_TEXT = (blocker: PreflightBlocker): string => {
  switch (blocker.kind) {
    case 'sealed-looking-rows':
      return `${blocker.blockIds.length} block(s) already hold values shaped like encrypted ones, which the conversion could not tell apart afterwards: ${blocker.blockIds.join(', ')}.`
    case 'pending-uploads':
      return `This device has ${blocker.count} change(s), in any workspace, that haven't uploaded yet. Wait for them to sync.`
    case 'rejected-uploads':
      return `${blocker.count} change(s) were rejected by the server. Retry or discard them first.`
    case 'pins-not-durable':
      return "This browser can't keep this workspace's encryption setting (storage is blocked or in private mode)."
    case 'key-store-not-durable':
      return "This browser can't keep the workspace key between visits (storage is blocked or in private mode)."
    case 'no-directory-picker':
      return 'Converting writes a recovery folder, which needs desktop Chrome or Edge.'
  }
}

const sealingStuckText = (pass: Exclude<SealingPass, {kind: 'purged'}>): string =>
  pass.kind === 'purge-refused'
    ? `the server refused to delete it (${pass.message}).`
    : 'the recovery bundle kept going out of date.'

const pinUpgradeFailure = (result: Exclude<UpgradeWorkspacePinResult, {ok: true}>): string => {
  switch (result.reason) {
    case 'refused':
      switch (result.entry.kind) {
        case 'unavailable':
          return "Can't reach the server to open the workspace on this device. Check your connection and try again."
        case 'copied-ciphertext':
          return "An older version of the app copied encrypted data into this device's local copy, so this device needs a reset before it can open the workspace. The workspace's gate explains how."
        case 'converting':
          return "The server isn't ready for this device to open the workspace yet. Try again in a moment."
      }
      break
    case 'storage':
      return "This device couldn't save the change (storage may be full or blocked). Try again."
    case 'format':
    case 'invalid-key':
    case 'no-stored-key':
      return "The key on this device doesn't open the workspace. Paste the key you saved on the next run."
  }
  return 'The workspace could not be opened on this device.'
}

function ResultView({result, retry, onClose}: {result: ConversionRunResult; retry: () => void; onClose: () => void}) {
  const close = {label: 'Close', onClick: onClose}
  const again = {label: 'Try again', onClick: retry}
  switch (result.kind) {
    case 'busy':
      return (
        <>
          <Explanation>The conversion is already running in another tab of this browser.</Explanation>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'blocked':
      return (
        <>
          <Explanation>
            {result.read.kind === 'unavailable' && "Can't reach the server. Check your connection."}
            {result.read.kind === 'not-visible' && "This workspace isn't visible to your account."}
            {result.read.kind === 'not-owner' && 'Only the workspace owner can convert it.'}
            {result.read.kind === 'unexpected' && `The server shows a state the conversion doesn't expect (${result.read.detail}).`}
          </Explanation>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'preflight-failed':
      return (
        <>
          <Explanation>The workspace can't be converted yet:</Explanation>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {result.blockers.map(blocker => <li key={blocker.kind}>{BLOCKER_TEXT(blocker)}</li>)}
          </ul>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'flip-refused':
      return (
        <>
          <p className="text-sm text-destructive">The server refused the conversion: {result.message}</p>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'stage-moved-back':
      return (
        <>
          <p className="text-sm text-destructive">
            The server shows an earlier step ({result.shown.kind}) than this run had reached ({result.reached}).
            Nothing more was done; try again in a moment.
          </p>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'sealing-stuck':
      return (
        <>
          <p className="text-sm text-destructive">
            The server's history could not be deleted: {sealingStuckText(result.pass)}
          </p>
          <Explanation>Nothing is lost. The next run carries on; if this keeps happening, it needs looking into.</Explanation>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'pin-upgrade-failed':
      return (
        <>
          <p className="text-sm text-destructive">{pinUpgradeFailure(result.result)}</p>
          <Actions primary={again} secondary={close}/>
        </>
      )
    case 'stopped':
      return (
        <>
          <Explanation>
            The workspace's content is encrypted on the server, and this device is opening it again.
            Its attachments still need converting, which this version of the app can't do yet.
          </Explanation>
          <Actions secondary={close}/>
        </>
      )
    case 'done':
      return (
        <>
          <Explanation>This workspace is end-to-end encrypted.</Explanation>
          <Actions secondary={close}/>
        </>
      )
  }
}
