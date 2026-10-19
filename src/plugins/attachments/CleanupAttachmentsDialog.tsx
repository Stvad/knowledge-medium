import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CleanerProgress, CleanerReport } from '@/sync/conversion/attachmentCleaner.js'
import { ConversionRefusal } from '@/sync/conversion/sealing.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import type { CleanupRun } from './cleanupAttachments.js'

export interface CleanupAttachmentsDialogProps {
  readonly run: CleanupRun
}

type State =
  | {readonly kind: 'idle'}
  | {readonly kind: 'running'; readonly progress: CleanerProgress | null}
  | {readonly kind: 'done'; readonly report: CleanerReport}
  | {readonly kind: 'failed'; readonly message: string}

const progressText = (progress: CleanerProgress | null): string => {
  if (!progress) return 'Starting…'
  switch (progress.phase) {
    case 'listing':
      return `Listing the workspace's files (pass ${progress.pass})…`
    case 'cleaning':
      return `Checking files: ${progress.done} of ${progress.total}`
    case 'proving':
      return `Verifying attachments: ${progress.done} of ${progress.total}`
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const ReportSummary = ({report}: {readonly report: CleanerReport}) => {
  const {proof} = report
  /** The sealed size the upload limits must reach for every refused-as-too-large file. */
  const tooLarge = Math.max(0, ...report.refused.filter(r => r.status === 413).map(r => r.sealedBytes))
  return (
    <div className="space-y-2 text-sm">
      <p>
        {proof.kind === 'passed'
          ? 'Every attachment is stored encrypted.'
          : 'Some attachments are not stored encrypted yet. Run this again once the issues below are fixed.'}
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {report.converted.length > 0 && <li>Encrypted {count(report.converted.length, 'plaintext file')}.</li>}
        {report.rebuilt.length > 0 && <li>Re-uploaded {count(report.rebuilt.length, 'missing or damaged file')}.</li>}
        {report.refused.length > 0 && (
          <li>
            The server refused {count(report.refused.length, 'file')}, which stay unencrypted for now.
            {tooLarge > 0 &&
              ` Raise the project’s Storage upload limit, and the attachments bucket’s limit if it is lower, to at least ${tooLarge.toLocaleString()} bytes, then run this again.`}
          </li>
        )}
        {report.left.length > 0 && <li>Left {count(report.left.length, 'file')} it could not identify in place.</li>}
        {report.errors.length > 0 && <li>{count(report.errors.length, 'step')} failed, for example offline: run this again.</li>}
        {proof.kind === 'passed' && proof.unrecoverable.length > 0 && (
          <li>
            {count(proof.unrecoverable.length, 'attachment')} {proof.unrecoverable.length === 1 ? 'has' : 'have'} no copy
            anywhere and can&apos;t be restored.
          </li>
        )}
        {proof.kind === 'not-passed' && proof.unsettled && <li>The workspace&apos;s files changed while this ran: close other tabs and devices, then run this again.</li>}
      </ul>
    </div>
  )
}

const failureMessage = (error: unknown, aborted: boolean): string => {
  if (aborted) return 'Stopped.'
  if (error instanceof ConversionRefusal) return 'The key on this device does not open this workspace.'
  return error instanceof Error ? error.message : String(error)
}

export const CleanupAttachmentsDialog = ({
  run,
  cancel,
}: CleanupAttachmentsDialogProps & DialogContextProps<never>) => {
  const [state, setState] = useState<State>({kind: 'idle'})
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  const start = () => {
    const controller = new AbortController()
    abort.current = controller
    setState({kind: 'running', progress: null})
    run(progress => setState({kind: 'running', progress}), controller.signal).then(
      report =>
        setState(
          report === 'busy'
            ? {kind: 'failed', message: 'A cleanup of this workspace is already running in another tab.'}
            : {kind: 'done', report},
        ),
      (error: unknown) => setState({kind: 'failed', message: failureMessage(error, controller.signal.aborted)}),
    )
  }


  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next && state.kind !== 'running') cancel()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clean up attachments</DialogTitle>
          <DialogDescription>
            Finds attachment files stored without encryption, for example by an older version of the app, encrypts them,
            and removes the plaintext copies once the encrypted ones are verified. Files it can&apos;t identify are left in
            place.
          </DialogDescription>
        </DialogHeader>
        {state.kind === 'running' && <p className="text-sm">{progressText(state.progress)}</p>}
        {state.kind === 'done' && <ReportSummary report={state.report} />}
        {state.kind === 'failed' && <p className="text-sm text-destructive">{state.message}</p>}
        <DialogFooter>
          {state.kind === 'idle' && <Button onClick={start}>Clean up</Button>}
          {state.kind === 'running' && (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          )}
          {state.kind !== 'running' && (
            <Button variant={state.kind === 'idle' ? 'outline' : 'default'} onClick={cancel}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
