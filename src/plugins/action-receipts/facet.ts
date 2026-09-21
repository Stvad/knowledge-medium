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
 *   - `showReceipt` (see `receipts.ts`) — for an action that already knows
 *     what it did and has the entry in hand (the SRS reschedule).
 */
import { keyedMapFacet } from '@/facets/facet.js'
import type { ActionContextType } from '@/shortcuts/types.js'
import type { ActionInvocation } from '@/shortcuts/actionDispatch.js'
import type { UndoEntry } from '@/data/internals/undoManager'
import type { Repo } from '@/data/repo'
import type { ChangeKind, EntrySummary, Phrase } from './summarize.ts'

export interface ReceiptRevert {
  /** The gesture the receipt's button offers. After an undo the button is
   *  Redo; after a fresh action, Undo. */
  direction: 'undo' | 'redo'
  /** The entry the button would replay. Live while it is the top of the
   *  matching stack of `workspaceId` — the same entry object moves between
   *  the stacks, so identity is the check. */
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
  /** Quiet variant: "Nothing to undo". Never enters the ledger. */
  tone?: 'neutral' | 'empty'
  /** Trailing note for the empty tone. */
  hint?: string
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
  /** `summary` phrased for a fresh action. Null with a null entry. */
  phrase: Phrase | null
  /** How many entries the action pushed — more than one for a gesture
   *  that fans out into one tx per block. */
  recorded: number
}

export interface ReceiptDescriber {
  actionId: string
  /** Narrow to one context when the same id is registered in several. */
  context?: ActionContextType
  /** Return null for "no receipt this time" — the common answer for a
   *  gesture whose effect the user can see. */
  describe: (ctx: ReceiptDescriberContext) => Receipt | null
}

export const actionReceiptsFacet = keyedMapFacet<ReceiptDescriber>(
  'action-receipts.describers',
  describer => describer.actionId,
)

/** The parent a moved subject landed under, in the state the gesture left. */
export const locationOf = (
  summary: EntrySummary,
  direction: 'undo' | 'redo' | 'forward',
): Receipt['location'] => {
  const subject = summary.subject
  if (subject === null || subject.kind !== 'move') return undefined
  const parent = direction === 'undo' ? subject.parentBefore : subject.parentAfter
  return parent === null ? undefined : {id: parent, workspaceId: subject.workspaceId}
}

/** The subject of a receipt, from a summary, for the state the gesture
 *  left behind. */
export const subjectOf = (
  summary: EntrySummary,
  direction: 'undo' | 'redo' | 'forward',
): ReceiptSubject | undefined => {
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
