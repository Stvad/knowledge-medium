import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SavedKeyProblem, SaveKeyPrompt } from '@/sync/conversion/conversionKey'
import type { PreflightBlocker, PreflightReport } from '@/sync/conversion/preflight'
import type {
  ActiveStage,
  ConversionFlowDeps,
  ConversionRunResult,
  ConversionStatus,
  ConversionUi,
} from '@/sync/conversion/runConversion'
import type { ConversionUnavailable } from './conversionFlowDeps'
import { useConversionRun, type PendingPrompt, type RunState } from './useConversionRun'

interface Props {
  readonly workspaceName: string | null
  readonly makeDeps: (ui: ConversionUi, signal: AbortSignal) => ConversionFlowDeps | ConversionUnavailable
  readonly onClose: () => void
}

/**
 * The conversion flow (docs/workspace-e2ee-conversion.md §6.3): one run at a
 * time, each starting from what the server shows. Closing it between runs is
 * always safe; a conversion past the flip carries on from the workspace's gate.
 */
export function ConversionFlow({workspaceName, makeDeps, onClose}: Props) {
  const {state, start, cancel} = useConversionRun(makeDeps)
  const name = workspaceName ? `"${workspaceName}"` : 'this workspace'

  return (
    <div className="flex min-h-svh items-start justify-center overflow-y-auto p-6 sm:items-center">
      <div className="w-full max-w-lg space-y-5 rounded-lg border bg-background p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Encrypt {name} end to end</h1>
        <FlowBody state={state} start={start} cancel={cancel} onClose={onClose}/>
      </div>
    </div>
  )
}

const Explanation = ({children}: {children: ReactNode}) => (
  <p className="text-sm text-muted-foreground">{children}</p>
)

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
      return state.pending
        ? <PromptView pending={state.pending} cancel={cancel}/>
        : (
          <>
            <StatusView status={state.status}/>
            <Actions secondary={{label: 'Stop', onClick: cancel}}/>
          </>
        )
    case 'finished':
      return <ResultView result={state.result} retry={start} onClose={onClose}/>
    case 'cancelled':
      return (
        <>
          <Explanation>Stopped. Nothing is lost: the next run carries on from where the server is.</Explanation>
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
    case 'unavailable':
      return (
        <>
          <Explanation>
            {state.why === 'no-server'
              ? 'Converting needs a signed-in, synced session.'
              : "This browser can't make sure the conversion runs in one tab only. Use desktop Chrome or Edge."}
          </Explanation>
          <Actions secondary={{label: 'Close', onClick: onClose}}/>
        </>
      )
  }
}

interface ActionProps {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
}

function Actions({primary, secondary}: {primary?: ActionProps; secondary?: ActionProps}) {
  return (
    <div className="flex justify-end gap-2">
      {secondary && <Button type="button" variant="secondary" onClick={secondary.onClick}>{secondary.label}</Button>}
      {primary && (
        <Button type="button" disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</Button>
      )}
    </div>
  )
}

function PromptView({pending, cancel}: {pending: PendingPrompt; cancel: () => void}) {
  switch (pending.kind) {
    case 'contract':
      return <ContractPrompt stage={pending.stage} answer={pending.answer} cancel={cancel}/>
    case 'preflight':
      return <PreflightPrompt report={pending.report} answer={pending.answer} cancel={cancel}/>
    case 'save-key':
      // A remount per key keeps a new key from inheriting the last one's step.
      return <SaveKeyPromptView key={pending.prompt.displayed} prompt={pending.prompt} answer={pending.answer} cancel={cancel}/>
    case 'saved-key':
      return <SavedKeyPrompt problem={pending.problem} answer={pending.answer} cancel={cancel}/>
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

function PreflightPrompt({answer, cancel}: {report: PreflightReport; answer: () => void; cancel: () => void}) {
  const [understood, setUnderstood] = useState(false)
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
      <ConfirmCheck id="conversion-residue" checked={understood} onChange={setUnderstood}>
        I understand, and this can't be undone.
      </ConfirmCheck>
      <Actions primary={{label: 'Create the key', onClick: answer, disabled: !understood}} secondary={{label: 'Cancel', onClick: cancel}}/>
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
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(prompt.displayed).then(() => setCopied(true), () => setCopied(false))
  }, [prompt.displayed])

  if (revealed) {
    return (
      <>
        <Explanation>
          This is the workspace key. It's shown only this once. Save it in two places, such as a
          password manager and paper. Every other device asks for it, and without it the content
          can't be read again.
        </Explanation>
        <code className="block select-all break-all rounded-md border bg-muted p-3 font-mono text-sm" data-testid="conversion-key">
          {prompt.displayed}
        </code>
        <div className="flex justify-between gap-2">
          <Button type="button" variant="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>
            <Button type="button" onClick={() => setRevealed(false)}>I've saved it</Button>
          </div>
        </div>
      </>
    )
  }
  return (
    <>
      <Explanation>Paste or type the key back from where you saved it.</Explanation>
      <div className="space-y-2">
        <Label htmlFor="conversion-key-check">Workspace key</Label>
        <Input
          id="conversion-key-check"
          autoFocus
          autoComplete="off"
          placeholder="kmp-wk-1:…"
          value={typed}
          onChange={event => setTyped(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && typed.trim()) answer(typed.trim()) }}
        />
        {prompt.mismatch && (
          <p className="text-sm text-destructive">
            That isn't the key shown. Check the copy you saved; if it's wrong, cancel and start again for a new key.
          </p>
        )}
      </div>
      <Actions primary={{label: 'Confirm', onClick: () => answer(typed.trim()), disabled: !typed.trim()}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

const SAVED_KEY_PROBLEM: Record<SavedKeyProblem, string> = {
  'stored-key-wrong': "The key on this device doesn't unlock the workspace. Paste the key you saved.",
  'format': "That doesn't look like a workspace key (expected kmp-wk-1:…).",
  'wrong-key': "That key doesn't unlock this workspace.",
}

function SavedKeyPrompt({problem, answer, cancel}: {
  problem: SavedKeyProblem | null
  answer: (pasted: string) => void
  cancel: () => void
}) {
  const [pasted, setPasted] = useState('')
  return (
    <>
      <Explanation>Paste the workspace key you saved when the conversion started.</Explanation>
      <div className="space-y-2">
        <Label htmlFor="conversion-saved-key">Workspace key</Label>
        <Input
          id="conversion-saved-key"
          autoFocus
          autoComplete="off"
          placeholder="kmp-wk-1:…"
          value={pasted}
          onChange={event => setPasted(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && pasted.trim()) answer(pasted.trim()) }}
        />
        {problem && <p className="text-sm text-destructive">{SAVED_KEY_PROBLEM[problem]}</p>}
      </div>
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
        ? `Waiting for the database to finish other writes (try ${status.waiting.attempt + 1}, in ${Math.ceil(status.waiting.retryInMs / 1000)} s)…`
        : 'Switching the server to encrypted mode…'
    case 'checking-key':
      return 'Checking the workspace key…'
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
      return `${blocker.count} change(s) on this device haven't uploaded yet. Wait for them to sync.`
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
            {result.report.blockers.map(blocker => <li key={blocker.kind}>{BLOCKER_TEXT(blocker)}</li>)}
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
            The server shows an earlier step ({result.to.kind}) than this run had reached ({result.from.kind}). Nothing more was done.
          </p>
          <Actions secondary={close}/>
        </>
      )
    case 'stopped':
      return (
        <>
          <Explanation>
            The server is in encrypted mode and this device holds the key. The remaining steps aren't
            available in this version of the app yet; the workspace stays closed until they run.
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
