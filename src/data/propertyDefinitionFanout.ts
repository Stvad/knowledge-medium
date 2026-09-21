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
 * it touched, and the undo record all come after, and a surface that vanishes
 * at the last consumer would hand the user back a still-frozen app. The
 * PROCESSOR only reports into whatever run is open, and reporting where
 * nothing is listening is a no-op — which is what keeps a headless caller (the
 * agent CLI, an importer) from needing to know this module exists.
 */
import { createWorkspaceSnapshotStore } from '@/utils/workspaceSnapshotStore.js'

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

export interface PropertyDefinitionFanoutSnapshot {
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

const store = createWorkspaceSnapshotStore<PropertyDefinitionFanoutSnapshot>(
  'property-definition-fanout',
)

export const subscribePropertyDefinitionFanout = store.subscribe
export const propertyDefinitionFanoutFor = store.getFor

/** Test helper — also drops the listeners, which no production caller may do. */
export const __resetPropertyDefinitionFanoutForTests = store.reset

export interface PropertyDefinitionFanoutRun {
  /** ALWAYS from a `finally`. A refused change rolls the transaction back and
   *  reports nothing on the way out, so a run left open by the throw is a
   *  modal over a workspace that is no longer busy. */
  end: () => void
}

/** Open the surface for a change the user has agreed to wait for.
 *
 *  No owner token, unlike the migration's run slot: there is one SQLite writer
 *  and a fan-out holds it for its whole duration, so a second definition
 *  change cannot be in flight anywhere in this tab to race the first. */
export const beginPropertyDefinitionFanout = (
  workspaceId: string, propertyName: string, total: number,
): PropertyDefinitionFanoutRun => {
  store.publish({workspaceId, propertyName, total, done: null})
  return {end: () => { store.clearFor(workspaceId) }}
}

/** How far the fan-out has got. Silently ignored when no run is open for this
 *  workspace — see the ownership note above.
 *
 *  A report is an UPDATE to a run somebody else opened and never the opening
 *  of one, which is the whole of what keeps a headless rename from putting a
 *  modal in front of the next reader. DEFENCE IN DEPTH as written, and
 *  deliberately so: deleting the early return fails no test, because a spread
 *  of `null` files its snapshot under no workspace at all and the store's
 *  per-workspace keying then hides it. What IS pinned is the rule — a
 *  processor that opened a run instead of reporting into one fails two named
 *  tests in `propertyDefinitionChange.test.ts`. */
export const reportPropertyDefinitionFanout = (
  workspaceId: string, done: number, total: number,
): void => {
  const live = store.getFor(workspaceId)
  if (live === null) return
  store.publish({...live, done, total})
}

/** Consumers between published progress reports.
 *
 *  The fan-out awaits several queries per consumer, so it does yield to the
 *  main thread often enough to paint — but notifying a React subscriber 40,000
 *  times to move a bar by a pixel is its own tax on the one thread the user is
 *  waiting on. At this stride a minute-long run publishes a couple of hundred
 *  times, which is smooth and costs nothing measurable. */
export const FANOUT_REPORT_STRIDE = 250
