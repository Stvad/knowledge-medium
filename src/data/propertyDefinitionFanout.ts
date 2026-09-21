/**
 * How big a property-definition change is before the user has to be told, and
 * where the fan-out says how far along it is.
 *
 * `core.migratePropertyDefinition` re-keys and re-encodes every consuming
 * block's cell inside the transaction that edits the definition. That is the
 * design and not a defect — one undoable step, ordinary synced rows, nothing
 * to claim or re-detect — but it holds the single SQLite writer for its whole
 * duration, so every other write and the sync drain queue behind it. On a
 * graph where a property has tens of thousands of owners that is tens of
 * seconds in which the app accepts no edit at all.
 *
 * Two surfaces answer that and they must agree on what "large" means, so the
 * threshold lives here with them: the gesture ASKS before it starts, and the
 * run it opens is what the fan-out reports into while it works. Two thresholds
 * would let the app freeze for a minute with no progress because the side that
 * decides to show progress called the fan-out small.
 *
 * WHO OWNS WHAT. The GESTURE opens and closes the run, because it is the only
 * thing that knows when the user's wait actually ends: the consumer loop is
 * not the last of it — the commit, the post-commit cache walk over every row
 * it touched, and the undo record all come after, and a surface that vanished
 * at the last consumer would hand the user back a still-frozen app (measured:
 * a third of a second of tail on 1,500 consumers, and it grows with them). The
 * PROCESSOR only reports into whatever run is open, and reporting where
 * nothing is listening is a no-op — which is what keeps a headless caller (the
 * agent CLI, an importer) from needing to know this module exists.
 *
 * ONE SLOT, NOT ONE PER WORKSPACE. A run describes the SQLite WRITER, and
 * there is one of those per tab: while a fan-out holds it every workspace's
 * writes are queued, so a surface filed under the workspace being renamed
 * vanishes the moment the user navigates to another one — leaving them in a
 * frozen app with no account of why. The workspace is still carried, as data a
 * report is matched against, never as the key the surface is found under.
 */
import { CallbackSet } from '@/utils/callbackSet.js'

/** Above this many consuming blocks a definition change is worth interrupting
 *  the user for, in both directions — a confirmation before, a progress
 *  surface during.
 *
 *  Chosen as roughly where the freeze stops reading as a slow save and starts
 *  reading as a hang: the fan-out costs a couple of milliseconds per consumer,
 *  so this is the low seconds. Below it the modal pair is the worse experience
 *  — two dialogs flashing past for a change that was over before they
 *  rendered. */
export const LARGE_FANOUT_CONSUMERS = 1_000

/** The one predicate. A gesture asks it once and gets both behaviours, which
 *  is why it is a function and not a comparison spelled at each site. */
export const isLargeFanout = (consumerCount: number): boolean =>
  consumerCount >= LARGE_FANOUT_CONSUMERS

/** Identity only — never inspected, so nothing can forge or guess one. */
type RunOwner = symbol

export interface PropertyDefinitionFanoutSnapshot {
  /** The workspace whose definition is changing. Carried so a report can be
   *  matched to the run it belongs to, and for nothing else — see the one-slot
   *  note above. */
  readonly workspaceId: string
  /** What the user is waiting on, in the words they used: the property being
   *  renamed or re-typed. */
  readonly propertyName: string
  /** Consuming blocks this change has to reach. The count the gesture took
   *  before it asked, replaced by the fan-out's own once it starts — they can
   *  differ, and the fan-out's is the one that is actually being walked. */
  readonly total: number
  /** Consumers rewritten so far. `null` until the fan-out reports, which is
   *  the honest state while the transaction is still getting to it. */
  readonly done: number | null
}

interface LiveRun extends PropertyDefinitionFanoutSnapshot {
  readonly owner: RunOwner
}

const listeners = new CallbackSet('property-definition-fanout')
let live: LiveRun | null = null

const publish = (next: LiveRun | null): void => {
  live = next
  listeners.notify()
}

export const subscribePropertyDefinitionFanout = (
  listener: () => void,
): (() => void) => listeners.add(listener)

/** The run on screen, or null. A stable reference until something publishes,
 *  so `useSyncExternalStore` can read it directly. */
export const propertyDefinitionFanout = (): PropertyDefinitionFanoutSnapshot | null => live

/** Test helper — also drops the listeners, which no production caller may do. */
export const __resetPropertyDefinitionFanoutForTests = (): void => {
  live = null
  listeners.clear()
}

export interface PropertyDefinitionFanoutRun {
  /** ALWAYS from a `finally`. A refused change rolls the transaction back and
   *  reports nothing on the way out, so a run left open by the throw is a
   *  modal over a workspace that is no longer busy. */
  end: () => void
}

/** Open the surface for a change the user has agreed to wait for.
 *
 *  FIRST-WINS, the same rule the migration's run slot uses, and for a reason
 *  "there is only one writer" does not cover: a run opens when the user
 *  CONFIRMS, which is before its transaction has the writer, so two confirmed
 *  gestures can both be waiting. Letting the second replace the first would
 *  point the first transaction's reports at the second property's name, and
 *  let the first's `end` take down a surface the second still needs. The
 *  loser's token owns nothing and every write it makes is a no-op. */
export const beginPropertyDefinitionFanout = (
  workspaceId: string, propertyName: string, total: number,
): PropertyDefinitionFanoutRun => {
  const owner: RunOwner = Symbol('property-definition-fanout')
  if (live === null) publish({workspaceId, propertyName, total, done: null, owner})
  return {
    end: () => { if (live?.owner === owner) publish(null) },
  }
}

/** How far the fan-out has got. Ignored when no run is open, and when the open
 *  one belongs to a different workspace's change.
 *
 *  A report is an UPDATE to a run somebody else opened and never the opening
 *  of one, which is the whole of what keeps a headless rename from putting a
 *  modal in front of the next reader. The rule is pinned where it can be: a
 *  processor that OPENED a run rather than reporting into one fails two named
 *  tests in `propertyDefinitionChange.test.ts`. */
export const reportPropertyDefinitionFanout = (
  workspaceId: string, done: number, total: number,
): void => {
  if (live === null || live.workspaceId !== workspaceId) return
  publish({...live, done, total})
}

/** Consumers between published progress reports.
 *
 *  The fan-out awaits several queries per consumer, so it does yield to the
 *  main thread often enough to paint — but notifying a React subscriber 40,000
 *  times to move a bar by a pixel is its own tax on the one thread the user is
 *  waiting on. At this stride a minute-long run publishes a couple of hundred
 *  times, which is smooth and costs nothing measurable. */
export const FANOUT_REPORT_STRIDE = 250
