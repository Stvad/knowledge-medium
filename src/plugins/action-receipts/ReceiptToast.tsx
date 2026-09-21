/**
 * The receipt strip: one line — glyph, verb, subject, the content delta —
 * with Go to when the subject is off-screen, the live inverse gesture, and
 * a way into the session ledger.
 *
 * The inverse button tracks the undo stack the way `repo.undo()` /
 * `repo.redo()` will act: it is enabled only while the receipt's entry is
 * the top of the matching stack of ITS workspace and that workspace is
 * active, and it re-checks at click time because an in-place workspace
 * switch does not notify undo subscribers.
 */
import { useSyncExternalStore } from 'react'
import { History, Redo2, Undo2 } from 'lucide-react'
import type { Repo } from '@/data/repo'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useHandle } from '@/hooks/block.js'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import { isMacPlatform } from '@/utils/platform.js'
import { dismissToast, showError } from '@/utils/toast.js'
import type { Receipt, ReceiptRevert } from './facet.ts'
import { ledgerOpen, type ShownReceipt } from './receipts.ts'

/** True when the inverse gesture would replay exactly `revert.entry`. */
export const revertIsLive = (repo: Repo, revert: ReceiptRevert): boolean => {
  if (repo.activeWorkspaceId !== revert.workspaceId) return false
  const manager = repo.undoManager
  const top = revert.direction === 'undo'
    ? manager.peekUndo(revert.entry.scope)
    : manager.peekRedo(revert.entry.scope)
  return top === revert.entry
}

export const useRevertIsLive = (repo: Repo, revert: ReceiptRevert | undefined): boolean =>
  useSyncExternalStore(
    cb => (revert ? repo.undoManagerFor(revert.workspaceId).subscribe(revert.entry.scope, cb) : () => {}),
    () => (revert ? revertIsLive(repo, revert) : false),
    () => false,
  )

export const runRevert = (repo: Repo, revert: ReceiptRevert): void => {
  if (!revertIsLive(repo, revert)) return
  const gesture = revert.direction === 'undo' ? repo.undo(revert.entry.scope) : repo.redo(revert.entry.scope)
  gesture.catch((err: unknown) => {
    showError(err instanceof Error ? err.message : `Could not ${revert.direction}`)
  })
}

export const revertChord = (direction: ReceiptRevert['direction']): string => {
  const mac = isMacPlatform()
  if (direction === 'undo') return mac ? '⌘Z' : 'Ctrl+Z'
  return mac ? '⌘⇧Z' : 'Ctrl+Y'
}

/** Live label for the subject; the snapshot label is the fallback while it
 *  loads and for a block that no longer resolves. */
const useSubjectLabel = (repo: Repo, subject: NonNullable<Receipt['subject']>): string =>
  useHandle(repo.block(subject.id), {
    selector: data => labelForBlockData(data, subject.label),
  })

const SubjectLabel = ({repo, subject}: {repo: Repo; subject: NonNullable<Receipt['subject']>}) => {
  const label = useSubjectLabel(repo, subject)
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

/** "Undid 3 steps" / "Deleted ×3" — the verb once several presses fold in. */
export const coalescedVerb = (receipt: Receipt, count: number): string => {
  if (count <= 1) return receipt.verb
  if (receipt.revert?.direction === 'redo') return `Undid ${count} steps`
  if (receipt.key === 'redo') return `Redid ${count} steps`
  return `${receipt.verb} ×${count}`
}

export interface ReceiptToastProps {
  toastId: string | number
  shown: ShownReceipt
  repo: Repo
}

export const ReceiptToast = ({toastId, shown, repo}: ReceiptToastProps) => {
  const {receipt, count, offscreen} = shown
  const live = useRevertIsLive(repo, receipt.revert)
  const peek = receipt.peek && (receipt.peek.gone || receipt.peek.now) ? receipt.peek : null
  // A peek is a window onto the content; naming the block by that same
  // content in front of it would say it twice.
  const showLabel = receipt.subject !== undefined && !(peek !== null && receipt.subject.labelIsContent)
  const glyph = receipt.revert?.direction === 'redo' || receipt.key === 'undo'
    ? <Undo2 className="size-3.5 shrink-0" aria-hidden />
    : receipt.key === 'redo'
      ? <Redo2 className="size-3.5 shrink-0" aria-hidden />
      : null

  if (receipt.tone === 'empty') {
    return (
      <div
        role="status"
        className="flex w-full min-w-[260px] items-center gap-3 rounded-md border bg-background px-4 py-3 text-sm shadow-lg text-muted-foreground"
      >
        {glyph}
        <span className="flex-1">
          {receipt.verb}
          {receipt.hint && <span className="ml-2 text-xs opacity-80">{receipt.hint}</span>}
        </span>
      </div>
    )
  }

  const goTo = () => {
    if (!receipt.subject) return
    void navigateFromGlobalCommand(repo, {blockId: receipt.subject.id, workspaceId: receipt.subject.workspaceId})
    dismissToast(toastId)
  }
  const revert = () => {
    if (!receipt.revert) return
    runRevert(repo, receipt.revert)
    dismissToast(toastId)
  }
  const openLedger = () => {
    ledgerOpen.open()
    dismissToast(toastId)
  }

  return (
    <div
      role="status"
      data-receipt-key={receipt.key}
      className="flex w-full min-w-[260px] max-w-[92vw] items-center gap-3 rounded-md border bg-background px-4 py-2.5 text-sm shadow-lg"
    >
      <span className="text-primary">{glyph}</span>
      <span className="flex-1 min-w-0 truncate">
        <span>{coalescedVerb(receipt, count)}</span>
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
      {offscreen && receipt.subject && (
        <Button variant="ghost" size="sm" onClick={goTo} title="Open the block this receipt is about">
          Go to
        </Button>
      )}
      {receipt.revert && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!live}
          onClick={revert}
          title={live
            ? `${receipt.revert.direction === 'undo' ? 'Undo' : 'Redo'} this`
            : `Another change ran since — use ${revertChord(receipt.revert.direction)} to step through history`}
        >
          {receipt.revert.direction === 'undo' ? 'Undo' : 'Redo'}
          <Kbd className="ml-1.5">{revertChord(receipt.revert.direction)}</Kbd>
        </Button>
      )}
      <Button variant="ghost" size="icon" className="size-7" onClick={openLedger} title="Recent actions" aria-label="Recent actions">
        <History className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}
