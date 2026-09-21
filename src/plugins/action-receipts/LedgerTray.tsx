/**
 * The session ledger: every receipt shown this session, newest first, with
 * the live undo / redo depth of the active workspace. Opened from a
 * receipt's history button or the `action-receipts.toggle_ledger` action;
 * mounted once via `appMountsFacet` and hidden until opened.
 *
 * Rows keep their Go to; the inverse gesture is offered only on the row
 * whose entry is still the top of a stack, which is the one cmd-Z /
 * cmd-shift-Z would replay.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Redo2, Undo2, X } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import { CallbackSet } from '@/utils/callbackSet'
import { Button } from '@/components/ui/button'
import { useRepo } from '@/context/repo.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import type { Receipt } from './facet.ts'
import { ledgerOpen, ledgerStore, type LedgerEntry } from './receipts.ts'
import { coalescedVerb, runRevert, useRevertIsLive } from './ReceiptToast.tsx'

/** A coarse clock for the relative times: ticks only while something is
 *  subscribed, so a closed tray costs nothing. */
const clock = (() => {
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null
  let subscribers = 0
  const listeners = new CallbackSet('action-receipts.clock')
  return {
    now: (): number => now,
    subscribe: (listener: () => void): (() => void) => {
      const off = listeners.add(listener)
      subscribers += 1
      if (timer === null) {
        now = Date.now()
        timer = setInterval(() => { now = Date.now(); listeners.notify() }, 10_000)
      }
      return () => {
        off()
        subscribers -= 1
        if (subscribers === 0 && timer !== null) { clearInterval(timer); timer = null }
      }
    },
  }
})()

const relativeTime = (at: number, now: number): string => {
  // The clock is coarse; an entry newer than its last tick reads "just now".
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return `${h} h ago`
}

const glyphFor = (receipt: Receipt) => {
  if (receipt.revert?.direction === 'redo' || receipt.key === 'undo') return <Undo2 className="size-3.5" aria-hidden />
  if (receipt.key === 'redo') return <Redo2 className="size-3.5" aria-hidden />
  return <span className="inline-block size-1.5 rounded-full bg-muted-foreground" aria-hidden />
}

const LedgerRow = ({entry, now}: {entry: LedgerEntry; now: number}) => {
  const repo = useRepo()
  const {receipt} = entry
  const live = useRevertIsLive(repo, receipt.revert)
  return (
    <li className="grid grid-cols-[16px_1fr_auto] items-start gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
      <span className="mt-0.5 text-primary">{glyphFor(receipt)}</span>
      <div className="min-w-0">
        <div className="truncate">
          <span>{coalescedVerb(receipt, 1)}</span>
          {receipt.subject && <span className="font-medium"> · {receipt.subject.label}</span>}
          {receipt.riders && <span className="text-muted-foreground"> {receipt.riders}</span>}
        </div>
        <div className="text-[11px] text-muted-foreground">{relativeTime(entry.at, now)}</div>
      </div>
      <div className="flex gap-0.5">
        {receipt.subject?.navigable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              void navigateFromGlobalCommand(repo, {blockId: receipt.subject!.id, workspaceId: receipt.subject!.workspaceId})
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

const useDepths = (): {undo: number; redo: number} => {
  const repo = useRepo()
  const snapshot = useSyncExternalStore(
    cb => repo.undoManager.subscribe(ChangeScope.BlockDefault, cb),
    () => {
      const d = repo.undoManager.depths(ChangeScope.BlockDefault)
      return `${d.undo}:${d.redo}`
    },
    () => '0:0',
  )
  const [undo, redo] = snapshot.split(':').map(Number)
  return {undo, redo}
}

export const LedgerTray = () => {
  const open = useSyncExternalStore(ledgerOpen.subscribe, ledgerOpen.isOpen, () => false)
  const entries = useSyncExternalStore(ledgerStore.subscribe, ledgerStore.entries, ledgerStore.entries)
  const depths = useDepths()
  const rootRef = useRef<HTMLDivElement>(null)
  const now = useSyncExternalStore(clock.subscribe, clock.now, clock.now)

  useEffect(() => {
    if (open) rootRef.current?.focus()
  }, [open])

  if (!open) return null
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Recent actions"
      data-action-receipts-ledger=""
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); ledgerOpen.close() } }}
      className="fixed bottom-3 left-3 z-40 flex max-h-[60vh] w-[320px] max-w-[92vw] flex-col rounded-lg border bg-background text-sm shadow-lg outline-none"
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
