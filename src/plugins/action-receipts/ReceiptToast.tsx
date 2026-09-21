/**
 * The receipt strip: glyph, verb, subject, the content delta, then Go to
 * when the subject is off-screen, the live inverse gesture, and a way into
 * the session ledger. The buttons wrap under the sentence when the toast's
 * width (sonner's, 356px) cannot hold both.
 */
import { useSyncExternalStore } from 'react'
import { History, Redo2, Undo2 } from 'lucide-react'
import type { Repo } from '@/data/repo'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useHandle } from '@/hooks/block.js'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import { dismissToast } from '@/utils/toast.js'
import type { Receipt, ReceiptRevert } from './facet.ts'
import {
  canGoTo,
  goToSubject,
  ledgerOpen,
  revertIsLive,
  runRevert,
  shownReceipt,
  type ShownReceipt,
} from './receipts.ts'

export const useRevertIsLive = (repo: Repo, revert: ReceiptRevert | undefined): boolean =>
  useSyncExternalStore(
    cb => (revert ? repo.undoManagerFor(revert.workspaceId).subscribe(revert.entry.scope, cb) : () => {}),
    () => (revert ? revertIsLive(repo, revert) : false),
    () => false,
  )

/** Live label for the subject; the snapshot label is the fallback while it
 *  loads and for a block that no longer resolves. */
const SubjectLabel = ({repo, subject}: {repo: Repo; subject: NonNullable<Receipt['subject']>}) => {
  const label = useHandle(repo.block(subject.id), {
    selector: data => labelForBlockData(data, subject.label),
  })
  return <span className="font-medium">{label}</span>
}

const LocationLabel = ({repo, location}: {repo: Repo; location: NonNullable<Receipt['location']>}) => {
  const label = useHandle(repo.block(location.id), {
    selector: data => labelForBlockData(data, '…'),
  })
  return <span className="text-muted-foreground"> → {label}</span>
}

const Peek = ({peek}: {peek: NonNullable<Receipt['peek']>}) => (
  <span className="text-muted-foreground">
    {peek.prefix}
    {peek.gone && <s className="decoration-destructive/70">{peek.gone}</s>}
    {peek.gone && peek.now && ' '}
    {peek.now && <span className="text-foreground">{peek.now}</span>}
    {peek.suffix}
  </span>
)

export const historyGlyph = (receipt: Receipt) => {
  if (receipt.history === 'undo') return <Undo2 className="size-3.5 shrink-0" aria-hidden />
  if (receipt.history === 'redo') return <Redo2 className="size-3.5 shrink-0" aria-hidden />
  return null
}

const inverseLabel = (direction: ReceiptRevert['direction']): string =>
  direction === 'undo' ? 'Undo' : 'Redo'

/** Why the inverse button is dead, for the wrapper's tooltip: a disabled
 *  button gets no pointer events, so the text sits on the span around it. */
export const deadRevertHint = (repo: Repo, revert: ReceiptRevert, chord: string | undefined): string => {
  if (repo.activeWorkspaceId !== revert.workspaceId) return 'This change is in another workspace'
  return chord
    ? `Another change ran since — use ${chord} to step through history`
    : 'Another change ran since — step through history instead'
}

export const EmptyReceiptToast = ({verb, hint}: {verb: string; hint: string}) => (
  <div className="flex w-full min-w-[260px] items-center gap-3 rounded-md border bg-background px-4 py-3 text-sm shadow-lg text-muted-foreground">
    <Undo2 className="size-3.5 shrink-0" aria-hidden />
    <span className="flex-1">
      {verb}
      <span className="ml-2 text-xs opacity-80">{hint}</span>
    </span>
  </div>
)

export interface ReceiptToastProps {
  toastId: string | number
  shown: ShownReceipt
  repo: Repo
}

export const ReceiptToast = ({toastId, shown, repo}: ReceiptToastProps) => {
  const {receipt, count, offscreen, chord} = shown
  const live = useRevertIsLive(repo, receipt.revert)
  const peek = receipt.peek && (receipt.peek.gone || receipt.peek.now) ? receipt.peek : null
  // A peek is a window onto the content; naming the block by that same
  // content in front of it would say it twice.
  const showLabel = receipt.subject !== undefined && !(peek !== null && receipt.subject.labelIsContent)
  const showGoTo = offscreen && receipt.subject !== undefined && canGoTo(repo, receipt.subject)
  const glyph = historyGlyph(receipt)

  const goTo = () => {
    if (receipt.subject) void goToSubject(repo, receipt.subject)
    dismissToast(toastId)
  }
  const revert = () => {
    if (receipt.revert) runRevert(repo, receipt.revert)
    dismissToast(toastId)
  }
  const openLedger = () => {
    ledgerOpen.open()
    dismissToast(toastId)
  }

  return (
    <div
      data-receipt-key={receipt.key}
      className="flex w-full min-w-[260px] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background px-4 py-2.5 text-sm shadow-lg"
    >
      <span className="flex min-w-0 flex-1 basis-40 items-start gap-2">
        {glyph && <span className="mt-0.5 text-primary">{glyph}</span>}
        <span className="min-w-0 line-clamp-2 break-words">
          {/* A folded toast shows the LATEST press in full; the chip counts the earlier ones. */}
          {count > 1 && (
            <span
              className="mr-1.5 inline-block rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground align-[1px]"
              title={`${count - 1} earlier ${count === 2 ? 'step' : 'steps'} folded into this receipt`}
            >
              +{count - 1}
            </span>
          )}
          <span>{receipt.verb}</span>
          {showLabel && receipt.subject && (
            <>
              <span className="text-muted-foreground"> · </span>
              <SubjectLabel repo={repo} subject={receipt.subject} />
            </>
          )}
          {receipt.riders && <span className="text-muted-foreground"> {receipt.riders}</span>}
          {receipt.location && <LocationLabel repo={repo} location={receipt.location} />}
          {peek && (
            <>
              <span className="text-muted-foreground"> · </span>
              <Peek peek={peek} />
            </>
          )}
        </span>
      </span>
      <span className="ml-auto flex items-center gap-1">
        {showGoTo && (
          <Button variant="ghost" size="sm" onClick={goTo} title="Open the block this receipt is about">
            Go to
          </Button>
        )}
        {receipt.revert && (
          <span title={live ? undefined : deadRevertHint(repo, receipt.revert, chord)}>
            <Button
              variant="ghost"
              size="sm"
              disabled={!live}
              onClick={revert}
              title={live ? `${inverseLabel(receipt.revert.direction)} this` : undefined}
            >
              {inverseLabel(receipt.revert.direction)}
              {chord && <Kbd className="ml-1.5">{chord}</Kbd>}
            </Button>
          </span>
        )}
        <Button variant="ghost" size="icon" className="size-7" onClick={openLedger} title="Recent actions" aria-label="Recent actions">
          <History className="size-3.5" aria-hidden />
        </Button>
      </span>
    </div>
  )
}

/** The toast sonner renders: it holds a ledger id and looks the receipt up
 *  at render time, so nothing heavy lives in the closure sonner retains. */
export const ReceiptToastSlot = ({toastId, ledgerId, repo}: {toastId: string | number; ledgerId: number; repo: Repo}) => {
  const shown = shownReceipt(ledgerId)
  if (shown === undefined) return null
  return <ReceiptToast toastId={toastId} shown={shown} repo={repo} />
}
