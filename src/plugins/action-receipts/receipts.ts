/**
 * The receipt surface: one toast slot per coalescing key, a session ledger
 * of everything shown, and the "where is it" check that decides whether a
 * receipt offers Go to or flashes the row instead.
 *
 * Module-level state on purpose (same shape as `createToggleStore`): the
 * toast library is imperative and mounted once, and a receipt can arrive
 * from a repo listener with no React tree in reach.
 */
import { createElement } from 'react'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { AppEffectContext } from '@/extensions/core.js'
import { formatChord } from '@/plugins/keybindings-settings/keyCapture.ts'
import { toChordArray } from '@/shortcuts/canonicalizeChord.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { CallbackSet } from '@/utils/callbackSet'
import { getElementScrollportBounds, isElementProperlyVisible, prefersReducedMotion } from '@/utils/dom.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import { createToggleStore } from '@/utils/toggleStore.js'
import { dismissToast, showCustom, showError, showInfo } from '@/utils/toast.js'
import type { Receipt, ReceiptRevert, ReceiptSubject } from './facet.ts'
import { EmptyReceiptToast, ReceiptToastSlot } from './ReceiptToast.tsx'

/** Presses closer together than this fold into one toast that counts up —
 *  three quick cmd-Zs read as one gesture, not three banners. */
export const COALESCE_MS = 1500
export const RECEIPT_DURATION_MS = 5000
export const EMPTY_RECEIPT_DURATION_MS = 2500
/** How many receipts the ledger keeps. Session-only. */
export const LEDGER_CAP = 50
/** How long to wait for the subject's row to appear before calling it
 *  off-screen. A structural change reaches the DOM a query round-trip and a
 *  lazy mount after the commit, so one look right after the write would read
 *  a row that is about to appear as off-screen. */
export const ROW_WAIT_MS = 300

// ── host ───────────────────────────────────────────────────────────────

interface Host {
  repo: Repo
  runtime: AppEffectContext['runtime']
}

/** Set by the plugin's app effect while the plugin is on. With no host the
 *  surface is not mounted, and `showReceipt` degrades to a plain toast so a
 *  flow that calls it directly (the SRS reschedule, the move flow) still
 *  confirms what it did. */
let host: Host | null = null

export const setReceiptsHost = (next: Host | null): void => {
  host = next
}

export const receiptsHost = (): Host | null => host

// ── ledger ─────────────────────────────────────────────────────────────

export interface LedgerEntry {
  id: number
  receipt: Receipt
  at: number
}

let ledger: readonly LedgerEntry[] = []
let nextId = 1
const ledgerListeners = new CallbackSet('action-receipts.ledger')

export const ledgerStore = {
  entries: (): readonly LedgerEntry[] => ledger,
  subscribe: (listener: () => void): (() => void) => ledgerListeners.add(listener),
}

/** Open / closed state of the ledger tray. */
export const ledgerOpen = createToggleStore('action-receipts.ledger-open')

export interface ShownReceipt {
  receipt: Receipt
  /** Presses folded into this toast, including this one. */
  count: number
  offscreen: boolean
  /** The inverse gesture's chord, from the live binding. */
  chord?: string
}

/** What a toast renders, by ledger id. The toast closure holds the id, not
 *  the receipt: sonner keeps every toast it ever showed for the session, and
 *  a receipt's entry carries full row snapshots. Evicted with the ledger. */
const shownById = new Map<number, ShownReceipt>()

export const shownReceipt = (ledgerId: number): ShownReceipt | undefined => shownById.get(ledgerId)

const appendToLedger = (receipt: Receipt): LedgerEntry => {
  const entry: LedgerEntry = {id: nextId++, receipt, at: Date.now()}
  const next = [entry, ...ledger]
  for (const dropped of next.slice(LEDGER_CAP)) shownById.delete(dropped.id)
  ledger = next.slice(0, LEDGER_CAP)
  ledgerListeners.notify()
  return entry
}

// ── where is it ────────────────────────────────────────────────────────

/** The subject's row in the ACTIVE panel, when the panel renders it and it
 *  is inside every scrollport around it. `data-block-id` is also on
 *  reference links and on other panels' copies, hence the shell + active-
 *  panel scoping. */
export const findVisibleRow = (blockId: string): HTMLElement | null => {
  if (typeof document === 'undefined') return null
  const selector = `[data-panel-active="true"] [data-block-shell="true"][data-block-id="${CSS.escape(blockId)}"]`
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (isElementProperlyVisible(el, getElementScrollportBounds(el))) return el
  }
  return null
}

const nextFrame = (): Promise<void> => new Promise(resolve => { requestAnimationFrame(() => resolve()) })

const tabHidden = (): boolean => document.visibilityState === 'hidden'

/** The subject's visible row, waiting up to `ROW_WAIT_MS` for it to appear.
 *  Frames do not run in a hidden tab, so there the answer is immediate. */
const waitForRow = async (blockId: string): Promise<HTMLElement | null> => {
  if (
    typeof document === 'undefined' ||
    typeof requestAnimationFrame !== 'function' ||
    tabHidden()
  ) return findVisibleRow(blockId)
  const deadline = performance.now() + ROW_WAIT_MS
  for (;;) {
    await nextFrame()
    const row = findVisibleRow(blockId)
    if (row !== null || performance.now() > deadline || tabHidden()) return row
  }
}

/** Draw the eye to the row the gesture changed. The shell wraps the whole
 *  subtree, so the flash goes on the row's own body (the element the focus
 *  highlight uses), not on the shell. */
export const flashRow = (shell: HTMLElement): void => {
  const body = shell.querySelector<HTMLElement>(':scope > .block-body > div:first-child') ?? shell
  if (typeof body.animate !== 'function') return
  const reduced = prefersReducedMotion()
  body.animate(
    [
      {backgroundColor: 'hsl(var(--primary) / 0.28)', offset: 0},
      {backgroundColor: 'hsl(var(--primary) / 0.2)', offset: reduced ? 0.8 : 0.35},
      {backgroundColor: 'transparent', offset: 1},
    ],
    {duration: reduced ? 900 : 1800, easing: 'ease-out'},
  )
}

// ── the inverse gesture ────────────────────────────────────────────────

/** True when the inverse gesture would replay exactly `revert.entry`:
 *  its workspace is active and the entry is the top of the matching
 *  stack. `repo.undoManager` is the active workspace's, which the first
 *  clause guarantees is the entry's. */
export const revertIsLive = (repo: Repo, revert: ReceiptRevert): boolean => {
  if (repo.activeWorkspaceId !== revert.workspaceId) return false
  const manager = repo.undoManager
  const top = revert.direction === 'undo'
    ? manager.peekUndo(revert.entry.scope)
    : manager.peekRedo(revert.entry.scope)
  return top === revert.entry
}

/** Re-checks at click time: an in-place workspace switch does not notify
 *  undo subscribers, so a button's enabled state can lag. */
export const runRevert = (repo: Repo, revert: ReceiptRevert): void => {
  if (!revertIsLive(repo, revert)) return
  const gesture = revert.direction === 'undo' ? repo.undo(revert.entry.scope) : repo.redo(revert.entry.scope)
  gesture.catch((err: unknown) => {
    showError(err instanceof Error ? err.message : `Could not ${revert.direction}`)
  })
}

/** The chord bound to the inverse gesture right now, from the effective
 *  action list, so a user who rebound undo sees their own key. */
const revertChord = (direction: ReceiptRevert['direction']): string | undefined => {
  if (host === null) return undefined
  const action = getEffectiveActions(host.runtime).find(candidate => candidate.id === direction)
  const [chord] = toChordArray(action?.defaultBinding?.keys ?? [])
  return chord ? formatChord(chord) : undefined
}

// ── go to ──────────────────────────────────────────────────────────────

/** Go to is offered only where a navigator command would land in the
 *  workspace the user is looking at. */
export const canGoTo = (repo: Repo, subject: ReceiptSubject): boolean =>
  subject.navigable && repo.activeWorkspaceId === subject.workspaceId

/** The subject may have been deleted since the receipt was shown; a
 *  navigator command checks nothing, so the check is here. */
export const goToSubject = async (repo: Repo, subject: ReceiptSubject): Promise<void> => {
  if (!canGoTo(repo, subject)) return
  if (!await repo.exists(subject.id)) {
    showInfo('That block is gone.')
    return
  }
  await navigateFromGlobalCommand(repo, {blockId: subject.id, workspaceId: subject.workspaceId})
}

// ── the toast slot ─────────────────────────────────────────────────────

interface Slot {
  key: string
  toastId: string | number
  count: number
  lastAt: number
}

let slot: Slot | null = null
let nextToastId = 1

const plainText = (receipt: Receipt): string =>
  [receipt.verb, receipt.subject?.label, receipt.riders].filter(Boolean).join(' · ')

/** Show a receipt. */
export const showReceipt = async (receipt: Receipt, repo: Repo): Promise<void> => {
  if (host === null) {
    showInfo(plainText(receipt))
    return
  }
  if (receipt.empty !== undefined) {
    // Its own toast, and no slot: a "nothing happened" must neither fold
    // into the previous receipt nor take it down.
    const hint = receipt.empty.hint
    showCustom(
      () => createElement(EmptyReceiptToast, {verb: receipt.verb, hint}),
      {id: `action-receipt:${nextToastId++}`, duration: EMPTY_RECEIPT_DURATION_MS},
    )
    return
  }
  const locatable = receipt.subject !== undefined && receipt.subject.navigable
  const row = locatable ? await waitForRow(receipt.subject!.id) : null
  const offscreen = locatable && row === null
  if (row !== null) flashRow(row)
  const entry = appendToLedger(receipt)

  const now = Date.now()
  const coalesce = slot !== null && slot.key === receipt.key && now - slot.lastAt < COALESCE_MS
  // One receipt on screen at a time: a receipt that does not fold into the
  // previous toast replaces it. The id is fresh each time: sonner keeps a
  // dismissed id as deleted, so re-using one after the toast has gone
  // renders nothing.
  if (slot !== null && !coalesce) dismissToast(slot.toastId)
  const toastId = coalesce ? slot!.toastId : `action-receipt:${nextToastId++}`
  const count = coalesce ? slot!.count + 1 : 1
  slot = {key: receipt.key, toastId, count, lastAt: now}

  shownById.set(entry.id, {
    receipt,
    count,
    offscreen,
    chord: receipt.revert === undefined ? undefined : revertChord(receipt.revert.direction),
  })
  showCustom(
    id => createElement(ReceiptToastSlot, {toastId: id, ledgerId: entry.id, repo}),
    {id: toastId, duration: RECEIPT_DURATION_MS},
  )
}

/** The `BlockDefault` entry on top of `workspaceId`'s undo stack — what a
 *  flow that just wrote reads to offer Undo on its receipt. */
export const topEntry = (repo: Repo, workspaceId: string) =>
  repo.undoManagerFor(workspaceId).peekUndo(ChangeScope.BlockDefault)
