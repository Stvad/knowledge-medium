/**
 * The session ledger: every receipt shown this session, newest first, with
 * the live undo / redo depth of the active workspace. Opened from a
 * receipt's history button or the `action-receipts.toggle_ledger` action;
 * mounted once via `appMountsFacet`, and its body exists only while open so
 * a closed tray subscribes to nothing.
 *
 * Non-modal and never focused on open: an overlay that takes DOM focus
 * blurs CodeMirror and ends edit mode. Escape closes it only while focus is
 * inside it.
 */
import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import { Button } from '@/components/ui/button'
import { useRepo } from '@/context/repo.js'
import { useMinuteClock } from '@/hooks/useMinuteClock.js'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { formatRelativeTime } from '@/utils/relativeTime.js'
import { canGoTo, goToSubject, ledgerOpen, ledgerStore, runRevert, type LedgerEntry } from './receipts.ts'
import { historyGlyph, useRevertIsLive } from './ReceiptToast.tsx'

const LedgerRow = ({entry, now}: {entry: LedgerEntry; now: number}) => {
  const repo = useRepo()
  const {receipt} = entry
  const live = useRevertIsLive(repo, receipt.revert)
  const glyph = historyGlyph(receipt)
  return (
    <li className="grid grid-cols-[16px_1fr_auto] items-start gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
      <span className="mt-0.5 text-primary">
        {glyph ?? <span className="inline-block size-1.5 rounded-full bg-muted-foreground" aria-hidden />}
      </span>
      <div className="min-w-0">
        <div className="truncate">
          <span>{receipt.verb}</span>
          {receipt.subject && <span className="font-medium"> · {receipt.subject.label}</span>}
          {receipt.riders && <span className="text-muted-foreground"> {receipt.riders}</span>}
        </div>
        {/* The clock is a minute clock; a fresh entry never reads as in the future. */}
        <div className="text-[11px] text-muted-foreground">{formatRelativeTime(entry.at, Math.max(now, entry.at))}</div>
      </div>
      <div className="flex gap-0.5">
        {receipt.subject && canGoTo(repo, receipt.subject) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              void goToSubject(repo, receipt.subject!)
              ledgerOpen.close()
            }}
          >
            Go to
          </Button>
        )}
        {receipt.revert && live && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => { runRevert(repo, receipt.revert!) }}
          >
            {receipt.revert.direction === 'undo' ? 'Undo' : 'Redo'}
          </Button>
        )}
      </div>
    </li>
  )
}

/** Undo / redo depth of the active workspace, re-bound when it changes. */
const useDepths = (): {undo: number; redo: number} => {
  const repo = useRepo()
  const workspaceId = useActiveWorkspaceId()
  const snapshot = useSyncExternalStore(
    cb => (workspaceId ? repo.undoManagerFor(workspaceId).subscribe(ChangeScope.BlockDefault, cb) : () => {}),
    () => {
      if (!workspaceId) return '0:0'
      const d = repo.undoManagerFor(workspaceId).depths(ChangeScope.BlockDefault)
      return `${d.undo}:${d.redo}`
    },
    () => '0:0',
  )
  const [undo, redo] = snapshot.split(':').map(Number)
  return {undo, redo}
}

const LedgerBody = () => {
  const entries = useSyncExternalStore(ledgerStore.subscribe, ledgerStore.entries, ledgerStore.entries)
  const depths = useDepths()
  const now = useMinuteClock()
  return (
    <div
      tabIndex={-1}
      role="region"
      aria-label="Recent actions"
      data-action-receipts-ledger=""
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); ledgerOpen.close() } }}
      className="fixed bottom-[4.75rem] left-3 z-40 flex max-h-[60vh] w-[320px] max-w-[92vw] flex-col rounded-lg border bg-background text-sm shadow-lg outline-none md:bottom-3"
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>Recent actions</span>
        <span className="flex-1" />
        <span className="font-mono normal-case tracking-normal tabular-nums" title="Undo · redo steps available">
          ↶ {depths.undo} · ↷ {depths.redo}
        </span>
        <Button variant="ghost" size="icon" className="size-6" onClick={ledgerOpen.close} aria-label="Close">
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          Nothing yet. Receipts appear here after undo, redo, and actions whose effect is off-screen.
        </div>
      ) : (
        <ul className="overflow-y-auto">
          {entries.map(entry => <LedgerRow key={entry.id} entry={entry} now={now} />)}
        </ul>
      )}
    </div>
  )
}

export const LedgerTray = () => {
  const open = useSyncExternalStore(ledgerOpen.subscribe, ledgerOpen.isOpen, () => false)
  return open ? <LedgerBody /> : null
}
