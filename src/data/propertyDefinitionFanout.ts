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
 * it touched, and the undo record all come after, and that tail grows with
 * the fan-out — a surface that vanished at the last consumer would hand the
 * user back a still-frozen app. The PROCESSOR only reports into whatever run is open, and reporting where
 * nothing is listening is a no-op — which is what keeps a headless caller (the
 * agent CLI, an importer) from needing to know this module exists.
 *
 * ONE SLOT, NOT ONE PER WORKSPACE. A run describes the SQLite WRITER, and
 * there is one of those per tab: while a fan-out holds it every workspace's
 * writes are queued, so a surface filed under the workspace being renamed
 * vanishes the moment the user navigates to another one — leaving them in a
 * frozen app with no account of why.
 *
 * A report is matched to the run by the DEFINITION it is changing, not by the
 * workspace. Only the gesture is serialised, and headless callers — the agent
 * CLI, an importer — are the ones this module deliberately asks nothing of,
 * so one of them can hold the writer while a confirmation is open; a
 * workspace match would then pour its counts into a modal titled for another
 * property, up to and including declaring it saved before its own
 * transaction had started.
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

/** One definition change at a time, from the moment it starts ASKING to the
 *  moment its transaction commits.
 *
 *  Two gestures reach the gate from one user action — blurring the name field
 *  and clicking the type picker in the same gesture does exactly that — and
 *  each awaits a count before opening its dialog, so both dialogs queue and
 *  both can be confirmed. Nothing a second change carries is true until the
 *  first has committed: its consumer count, the row its confirmation
 *  describes and the baseline its staleness check is judged against are all
 *  about a row that is about to change. So it does not get to count, ask or
 *  write until then.
 *
 *  Chained rather than rejected, because both changes are ones the user
 *  asked for. `then(fn, fn)` so a change that throws does not strand every
 *  change after it. */
let queue: Promise<unknown> = Promise.resolve()

export const queueDefinitionChange = <T>(change: () => Promise<T>): Promise<T> => {
  const next = queue.then(change, change)
  queue = next.then(() => undefined, () => undefined)
  return next
}

/** Identity only — never inspected, so nothing can forge or guess one. */
type RunOwner = symbol

export interface PropertyDefinitionFanoutSnapshot {
  /** The workspace whose definition is changing. */
  readonly workspaceId: string
  /** The definition block. Carried so a report can be matched to the run it
   *  belongs to, and for nothing else — see the one-slot note above. */
  readonly fieldId: string
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
  /** Is THIS run's transaction the one currently holding the writer?
   *
   *  A run opens when the user confirms, which is before its transaction has
   *  the writer — and only the gesture is serialised, so a headless caller
   *  can be mid-change over the same definition in that gap. Identity does
   *  not separate them: same workspace, same definition. What does is that
   *  the writer is exclusive, so a report arriving while this run's own
   *  transaction is running can only be its own. The gesture sets this from
   *  inside that transaction. */
  readonly transactionRunning: boolean
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
  queue = Promise.resolve()
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
 *  FIRST-WINS, the same rule the migration's run slot uses. DEFENCE IN DEPTH
 *  now that {@link queueDefinitionChange} admits one change at a time: a
 *  second run cannot be opened through the gate while the first is live, so
 *  nothing reaches this branch from there. Kept, and kept pinned by the
 *  surface's own tests, because the loser of that race is left with a handle
 *  that can never publish — sound only while nothing is queueing behind it,
 *  which is a property of the CALLER, and a store that silently let one
 *  caller's run repoint another's is the wrong thing to leave lying around. */
export const beginPropertyDefinitionFanout = (
  workspaceId: string, fieldId: string, propertyName: string, total: number,
): PropertyDefinitionFanoutRun => {
  const owner: RunOwner = Symbol('property-definition-fanout')
  if (live === null) {
    publish({
      workspaceId, fieldId, propertyName, total,
      done: null, transactionRunning: false, owner,
    })
  }
  return {
    end: () => { if (live?.owner === owner) publish(null) },
  }
}

/** How far the fan-out has got, from a transaction changing `fieldIds`.
 *  Ignored when no run is open, and when the open one is not about any of
 *  them — the transaction holding the writer is not necessarily the one the
 *  user is waiting on.
 *
 *  A report is an UPDATE to a run somebody else opened and never the opening
 *  of one, which is the whole of what keeps a headless rename from putting a
 *  modal in front of the next reader. The rule is pinned where it can be: a
 *  processor that OPENED a run rather than reporting into one fails two named
 *  tests in `propertyDefinitionChange.test.ts`. */
export const reportPropertyDefinitionFanout = (
  workspaceId: string, fieldIds: readonly string[], done: number, total: number,
): void => {
  if (live?.transactionRunning !== true) return
  amendLiveRun(workspaceId, fieldIds, {done, total})
}

/** Said by the GESTURE from inside its own transaction — see
 *  {@link PropertyDefinitionFanoutSnapshot.transactionRunning}. */
export const markPropertyDefinitionFanoutRunning = (
  workspaceId: string, fieldId: string,
): void => {
  amendLiveRun(workspaceId, [fieldId], {transactionRunning: true})
}

const amendLiveRun = (
  workspaceId: string,
  fieldIds: readonly string[],
  patch: Partial<PropertyDefinitionFanoutSnapshot>,
): void => {
  if (live === null || live.workspaceId !== workspaceId) return
  if (!fieldIds.includes(live.fieldId)) return
  publish({...live, ...patch})
}

/** Consumers between published progress reports.
 *
 *  The fan-out awaits several queries per consumer, so it does yield to the
 *  main thread often enough to paint — but notifying a React subscriber 40,000
 *  times to move a bar by a pixel is its own tax on the one thread the user is
 *  waiting on. At this stride a minute-long run publishes a couple of hundred
 *  times, which is smooth and costs nothing measurable. */
export const FANOUT_REPORT_STRIDE = 250
