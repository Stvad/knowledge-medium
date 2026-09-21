/**
 * action-receipts plugin — a short receipt after undo, redo, and actions
 * whose effect is off-screen: what changed, where it lives, and the live
 * inverse gesture. Design: docs/action-receipts.html.
 *
 * Composition:
 *   - `facet.ts`        — the `Receipt` shape and the describer facet
 *   - `summarize.ts`    — undo entry → words (pure)
 *   - `receipts.ts`     — the toast slot, coalescing, the session ledger,
 *                         and the on-screen / off-screen decision
 *   - `dispatch.ts`     — observers on the action-dispatch verb
 *   - `describers.ts`   — receipts for core actions (delete)
 *   - `ReceiptToast.tsx` / `LedgerTray.tsx` — the two surfaces
 *
 * Undo and redo receipts come from `repo.onHistoryReplay`, which fires for
 * every path into `repo.undo()` / `repo.redo()`, not just the shortcut.
 */
import { History } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import {
  actionsFacet,
  appEffectsFacet,
  appMountsFacet,
  type AppEffect,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { actionDispatchVerb } from '@/shortcuts/actionDispatch.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { deleteBlockReceipt, multiSelectDeleteReceipt } from './describers.ts'
import { receiptsAfterDispatch, receiptsBeforeDispatch, setReceiptsHost } from './dispatch.ts'
import { actionReceiptsFacet, locationOf, subjectOf, type Receipt } from './facet.ts'
import { LedgerTray } from './LedgerTray.tsx'
import { ledgerOpen, showReceipt } from './receipts.ts'
import { phrase, summarizeEntry } from './summarize.ts'

export { actionReceiptsFacet, locationOf, subjectOf, type Receipt, type ReceiptDescriber } from './facet.ts'
export { showReceipt, ledgerOpen } from './receipts.ts'
export { summarizeEntry, phrase } from './summarize.ts'

export const TOGGLE_LEDGER_ACTION_ID = 'action-receipts.toggle_ledger'

const SOURCE = {source: 'action-receipts'}

const EMPTY_HINT = 'History is per workspace and starts fresh each session.'

const receiptsHostEffect: AppEffect = {
  id: 'action-receipts.host',
  start: ({repo, runtime}) => {
    setReceiptsHost({repo, runtime})
    const off = repo.onHistoryReplay(event => {
      if (event.scope !== ChangeScope.BlockDefault) return
      if (event.entry === null) {
        void showReceipt({key: event.kind, verb: `Nothing to ${event.kind}`, tone: 'empty', hint: EMPTY_HINT}, repo)
        return
      }
      const summary = summarizeEntry(event.entry)
      const words = phrase(summary, event.kind)
      const receipt: Receipt = {
        key: event.kind,
        verb: words.verb,
        subject: subjectOf(summary, event.kind),
        riders: words.riders,
        location: locationOf(summary, event.kind),
        peek: words.peek,
        revert: {
          direction: event.kind === 'undo' ? 'redo' : 'undo',
          entry: event.entry,
          workspaceId: event.workspaceId,
        },
      }
      void showReceipt(receipt, repo)
    })
    return () => {
      off()
      setReceiptsHost(null)
    }
  },
}

const toggleLedgerAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: TOGGLE_LEDGER_ACTION_ID,
  description: 'Recent actions',
  context: ActionContextTypes.GLOBAL,
  icon: History,
  handler: () => { ledgerOpen.toggle() },
}

export const actionReceiptsPlugin: AppExtension = systemToggle({
  id: 'system:action-receipts',
  name: 'Action receipts',
  description: 'A short receipt after undo, redo, and actions whose effect is off-screen: what changed, where, and how to take it back.',
}).of([
  appEffectsFacet.of(receiptsHostEffect, SOURCE),
  actionDispatchVerb.before(receiptsBeforeDispatch, SOURCE),
  actionDispatchVerb.after(receiptsAfterDispatch, SOURCE),
  appMountsFacet.of({id: 'action-receipts.ledger', component: LedgerTray}, SOURCE),
  actionsFacet.of(toggleLedgerAction, SOURCE),
  actionReceiptsFacet.of(deleteBlockReceipt, SOURCE),
  actionReceiptsFacet.of(multiSelectDeleteReceipt, SOURCE),
])
