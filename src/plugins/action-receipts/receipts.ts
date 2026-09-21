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
import type { Repo } from '@/data/repo'
import { CallbackSet } from '@/utils/callbackSet'
import { createToggleStore } from '@/utils/toggleStore.js'
import { dismissToast, showCustom } from '@/utils/toast.js'
import type { Receipt } from './facet.ts'
import { ReceiptToast } from './ReceiptToast.tsx'

/** Presses closer together than this fold into one toast that counts up —
 *  three quick cmd-Zs read as one gesture, not three banners. */
export const COALESCE_MS = 1500
export const RECEIPT_DURATION_MS = 5000
export const EMPTY_RECEIPT_DURATION_MS = 2500
/** How many receipts the ledger keeps. Session-only. */
export const LEDGER_CAP = 50

export interface LedgerEntry {
  id: number
  receipt: Receipt
  at: number
  /** Where the subject was when the receipt was shown. Decides the Go to
   *  button; kept on the entry so the ledger can offer it too. */
  offscreen: boolean
}

// ── ledger ─────────────────────────────────────────────────────────────

let ledger: readonly LedgerEntry[] = []
let nextId = 1
const ledgerListeners = new CallbackSet('action-receipts.ledger')

export const ledgerStore = {
  entries: (): readonly LedgerEntry[] => ledger,
  subscribe: (listener: () => void): (() => void) => ledgerListeners.add(listener),
  clear: (): void => {
    ledger = []
    ledgerListeners.notify()
  },
}

/** Open / closed state of the ledger tray. */
export const ledgerOpen = createToggleStore('action-receipts.ledger-open')

const appendToLedger = (receipt: Receipt, offscreen: boolean): LedgerEntry => {
  const entry: LedgerEntry = {id: nextId++, receipt, at: Date.now(), offscreen}
  ledger = [entry, ...ledger].slice(0, LEDGER_CAP)
  ledgerListeners.notify()
  return entry
}

// ── where is it ────────────────────────────────────────────────────────

/** The subject's row in the ACTIVE panel, when the panel renders it and it
 *  is inside the viewport. `data-block-id` is also on reference links and
 *  on other panels' copies, hence the shell + active-panel scoping. */
export const findVisibleRow = (blockId: string): HTMLElement | null => {
  if (typeof document === 'undefined') return null
  const selector = `[data-panel-active="true"] [data-block-shell="true"][data-block-id="${CSS.escape(blockId)}"]`
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = el.getBoundingClientRect()
    const inViewport = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0
    if (inViewport) return el
  }
  return null
}

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Draw the eye to the row the gesture changed. The shell wraps the whole
 *  subtree, so the flash goes on the row's own body (the element the focus
 *  highlight uses), not on the shell. */
export const flashRow = (shell: HTMLElement): void => {
  const body = shell.querySelector<HTMLElement>(':scope > .block-body > div:first-child') ?? shell
  if (typeof body.animate !== 'function') return
  const hold = prefersReducedMotion() ? 900 : 1800
  body.animate(
    [
      {backgroundColor: 'hsl(var(--primary) / 0.28)', offset: 0},
      {backgroundColor: 'hsl(var(--primary) / 0.2)', offset: prefersReducedMotion() ? 0.8 : 0.35},
      {backgroundColor: 'transparent', offset: 1},
    ],
    {duration: hold, easing: 'ease-out'},
  )
}

const afterPaint = (): Promise<void> =>
  new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'function') { resolve(); return }
    // Two frames: the replay's commit has to reach React and React has to
    // reach the DOM before "is it rendered" means anything.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

// ── the toast slot ─────────────────────────────────────────────────────

interface Slot {
  key: string
  toastId: string | number
  count: number
  lastAt: number
  first: Receipt
}

let slot: Slot | null = null
let nextToastId = 1

export interface ShownReceipt {
  receipt: Receipt
  /** Presses folded into this toast, including this one. */
  count: number
  offscreen: boolean
}

/** Show a receipt. Returns what was rendered, for tests and describers
 *  that want the coalesced count. */
export const showReceipt = async (receipt: Receipt, repo: Repo): Promise<ShownReceipt> => {
  await afterPaint()
  // A subject the gesture left deleted is neither on screen nor anywhere
  // to go to; the receipt names it and stops there.
  const locatable = receipt.subject !== undefined && receipt.subject.navigable
  const row = locatable ? findVisibleRow(receipt.subject!.id) : null
  const offscreen = locatable && row === null
  if (row !== null) flashRow(row)
  if (receipt.tone !== 'empty') appendToLedger(receipt, offscreen)

  const now = Date.now()
  const coalesce = slot !== null && slot.key === receipt.key && now - slot.lastAt < COALESCE_MS
    && receipt.tone !== 'empty'
  // One receipt on screen at a time: a receipt that does not fold into the
  // previous toast replaces it. The id is fresh each time: sonner keeps a
  // dismissed id as deleted, so re-using one after the toast has gone
  // renders nothing.
  if (slot !== null && !coalesce) dismissToast(slot.toastId)
  const toastId = coalesce ? slot!.toastId : `action-receipt:${nextToastId++}`
  const count = coalesce ? slot!.count + 1 : 1
  slot = {key: receipt.key, toastId, count, lastAt: now, first: coalesce ? slot!.first : receipt}

  const shown: ShownReceipt = {receipt, count, offscreen}
  showCustom(
    id => createElement(ReceiptToast, {toastId: id, shown, repo}),
    {
      id: toastId,
      duration: receipt.tone === 'empty' ? EMPTY_RECEIPT_DURATION_MS : RECEIPT_DURATION_MS,
    },
  )
  return shown
}

/** Test seam. */
export const resetReceiptsForTests = (): void => {
  slot = null
  ledger = []
  nextId = 1
  ledgerOpen.close()
}
