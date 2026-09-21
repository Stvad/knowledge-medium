/**
 * The receipts plugin's contract with the actions it reports on.
 *
 * A receipt is what the user gets after an action whose effect they cannot
 * see where they are looking: off-screen, an aggregate the viewport hides,
 * or no visible effect at all (cmd-Z on an empty stack). Actions whose
 * result is on screen get none — receipts close a perception gap, they do
 * not narrate the app.
 *
 * Two ways in:
 *   - `actionReceiptsFacet` — a describer keyed by action id. The plugin
 *     that owns the action says what its receipt reads; the receipts plugin
 *     observes every dispatch and asks the describer once the action has
 *     settled, handing it the undo entry the action recorded (if any).
 *     This is the route for core actions, which cannot import a plugin.
 *   - `showReceipt` (see `receipts.ts`) — for a flow that already knows
 *     what it did and has the entry in hand (the SRS reschedule, the move
 *     flow). Prefer it whenever the caller can reach the plugin: a receipt
 *     built from the flow's own result cannot be misattributed.
 */
import { keyedMapFacet } from '@/facets/facet.js'
import type { ActionInvocation } from '@/shortcuts/actionDispatch.js'
import type { UndoEntry } from '@/data/internals/undoManager'
import type { HistoryReplayEvent, Repo } from '@/data/repo'
import {
  phrase,
  summarizeEntry,
  type ChangeKind,
  type Direction,
  type EntrySummary,
  type Phrase,
} from './summarize.ts'

export interface ReceiptRevert {
  /** The gesture the receipt's button offers. After an undo the button is
   *  Redo; after a fresh action, Undo. */
  direction: 'undo' | 'redo'
  /** The entry the button would replay. Live while it is the top of the
   *  matching stack of `workspaceId` — the same entry object moves between
   *  the stacks, and a group merge mutates the top in place, so identity
   *  is the check. */
  entry: UndoEntry
  workspaceId: string
}

export interface ReceiptSubject {
  id: string
  workspaceId: string
  /** Fallback while the live label loads, and the ledger's label after the
   *  block is gone. */
  label: string
  /** True when `label` is the content itself, which a peek already shows. */
  labelIsContent: boolean
  kind: ChangeKind
  /** False when the gesture left the block deleted (a delete, an undone
   *  create): nothing to go to, nothing to flash. */
  navigable: boolean
}

export interface Receipt {
  /** Coalescing key: another receipt with the same key inside the
   *  coalescing window updates the toast in place instead of stacking. */
  key: string
  /** Set on undo / redo receipts: the gesture, for the glyph and the
   *  coalesced verb. */
  history?: 'undo' | 'redo'
  /** "Undid edit", "Restored", "Moved" — the gesture, in the user's words. */
  verb: string
  subject?: ReceiptSubject
  /** "and 7 children" — what came along with the subject. */
  riders?: string
  /** Where the subject ended up, for a move: rendered as "→ <label>",
   *  label read live. */
  location?: {id: string; workspaceId: string}
  /** The content delta the gesture made: `gone` left the text, `now`
   *  entered it. */
  peek?: Phrase['peek']
  /** Offers the inverse gesture while it is still the one cmd-Z /
   *  cmd-shift-Z would perform. */
  revert?: ReceiptRevert
  /** Quiet variant ("Nothing to undo"): never coalesces, never enters the
   *  ledger. */
  empty?: {hint: string}
}

export interface ReceiptDescriberContext {
  invocation: ActionInvocation
  repo: Repo
  /** The `BlockDefault` entry on top of the active workspace's undo stack
   *  after the action, when it is not the one that was there before — i.e.
   *  the action recorded it. Null when the action recorded nothing
   *  (refused, cancelled, no-op). */
  entry: UndoEntry | null
  /** `entry`, in words. Null with a null entry. */
  summary: EntrySummary | null
}

export interface ReceiptDescriber {
  actionId: string
  /** Return null for "no receipt this time" — the common answer for a
   *  gesture whose effect the user can see. */
  describe: (ctx: ReceiptDescriberContext) => Receipt | null
}

export const actionReceiptsFacet = keyedMapFacet<ReceiptDescriber>(
  'action-receipts.describers',
  describer => describer.actionId,
)

/** The parent a moved subject landed under, in the state the gesture left. */
export const locationOf = (summary: EntrySummary, direction: Direction): Receipt['location'] => {
  const subject = summary.subject
  if (subject === null || subject.kind !== 'move') return undefined
  const parent = direction === 'undo' ? subject.parentBefore : subject.parentAfter
  return parent === null ? undefined : {id: parent, workspaceId: subject.workspaceId}
}

/** The subject of a receipt, from a summary, for the state the gesture
 *  left behind. */
export const subjectOf = (summary: EntrySummary, direction: Direction): ReceiptSubject | undefined => {
  const subject = summary.subject
  if (subject === null) return undefined
  const gone = direction === 'undo' ? subject.kind === 'create' : subject.kind === 'delete'
  return {
    id: subject.id,
    workspaceId: subject.workspaceId,
    label: subject.label,
    labelIsContent: subject.labelIsContent,
    kind: subject.kind,
    navigable: !gone,
  }
}

/** The receipt for an entry a fresh action recorded: verb, subject, riders
 *  and a live Undo. Null when nothing was recorded or the subject is not of
 *  `kind` — the describer's guard that the entry is its own action's. */
export const recordedReceipt = (
  entry: UndoEntry | null,
  summary: EntrySummary | null,
  kind: ChangeKind,
  key: string,
): Receipt | null => {
  if (entry === null || summary === null) return null
  const subject = subjectOf(summary, 'forward')
  if (subject === undefined || subject.kind !== kind) return null
  const words = phrase(summary, 'forward')
  return {
    key,
    verb: words.verb,
    subject,
    riders: words.riders,
    location: locationOf(summary, 'forward'),
    peek: words.peek,
    revert: {direction: 'undo', entry, workspaceId: subject.workspaceId},
  }
}

export const EMPTY_HINT = 'History is per workspace and starts fresh each session.'

/** The receipt for a completed undo / redo gesture. The inverse is offered
 *  only when the event says the entry reached the opposite stack. */
export const historyReceipt = (event: HistoryReplayEvent): Receipt => {
  if (event.entry === null) {
    return {key: event.kind, history: event.kind, verb: `Nothing to ${event.kind}`, empty: {hint: EMPTY_HINT}}
  }
  const summary = summarizeEntry(event.entry)
  const words = phrase(summary, event.kind)
  return {
    key: event.kind,
    history: event.kind,
    verb: words.verb,
    subject: subjectOf(summary, event.kind),
    riders: words.riders,
    location: locationOf(summary, event.kind),
    peek: words.peek,
    revert: event.inverseOffered
      ? {direction: event.kind === 'undo' ? 'redo' : 'undo', entry: event.entry, workspaceId: event.workspaceId}
      : undefined,
  }
}
