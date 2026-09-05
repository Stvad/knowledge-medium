/*
 * The mirror's health on the shared status chip.
 *
 * Without this the feature fails silently: the user opts in once and never
 * opens the settings again, so a folder grant that lapses — or a full disk —
 * would stop the copies with nothing to notice. The chip is where the app
 * already says "look here".
 *
 * Health is read from THREE places, because no one of them can answer on its
 * own. The persisted status carries what previous sessions found and survives a
 * reload. The in-memory runtime signal carries what this session's ticks threw,
 * including the failures the store was too broken to record — which is the case
 * it exists for. And the CLOCK carries the rest: every way the loop can stop
 * producing runs without producing an error looks identical in both others.
 *
 * Reports nothing at all while mirroring is off, which is the default: a
 * feature the user has not asked for is not a health signal.
 */
import type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'
import {CallbackSet} from '@/utils/callbackSet.js'
import {dbMirrorRuntimeHealth} from './runtimeHealth.js'
import {dbMirrorStore, type DbMirrorState} from './store.js'

/** Declared here rather than beside the action so this module — which every
 *  status read pulls in — does not drag the settings dialog's React tree along
 *  with it. Same arrangement as `storage-persistence`. */
export const OPEN_DB_MIRROR_SETTINGS_ACTION_ID = 'open_db_mirror_settings'

const openSettings = {
  actionId: OPEN_DB_MIRROR_SETTINGS_ACTION_ID,
  actionLabel: 'Settings',
} as const

/** Intervals that may pass with no completed run before the chip stops calling
 *  the mirror healthy. Three rather than one: a run waits for a genuinely idle
 *  main thread with no deadline, so overshooting a single interval is ordinary
 *  and saying so would be crying wolf. */
const STALE_INTERVALS = 3

/** How often the clock is re-consulted while the chip is on screen. The loop's
 *  own ticks cannot serve as the heartbeat here — a session that never goes
 *  idle produces no ticks, and that is precisely the case being detected. */
const STALE_CHECK_MS = 5 * 60_000

const describeLastCopy = (state: DbMirrorState): string =>
  state.status.lastMirrorAt
    ? `Last copy ${new Date(state.status.lastMirrorAt).toLocaleString()}`
    : 'No copy taken yet'

/** Exported for its own test: the constant, the scaling by the user's interval
 *  and the direction of the comparison are the whole of this rule, and none of
 *  them is visible through {@link dbMirrorDiagnostic}, which takes the answer
 *  as a parameter. */
export const isMirrorStalled = (state: DbMirrorState, now: number): boolean =>
  state.status.lastCheckedAt !== undefined &&
  now - state.status.lastCheckedAt > STALE_INTERVALS * state.settings.intervalMinutes * 60_000

export const dbMirrorDiagnostic = (
  state: DbMirrorState | null,
  /** What this session's last tick threw, if anything — including the failures
   *  the store was too broken to record, which is why it exists. */
  runtimeFailure: string | undefined,
  stalled: boolean,
): DiagnosticSnapshot | null => {
  if (!state || !state.settings.enabled) return null
  if (state.status.permissionLost) {
    return {
      severity: 'warning',
      summary: 'Database mirror is paused',
      detail: state.status.lastError,
      nudge: true,
      ...openSettings,
    }
  }
  if (!state.directory) {
    return {
      severity: 'warning',
      summary: 'Database mirror has no folder',
      detail: 'Mirroring is on but no folder is chosen on this device, so nothing is being copied.',
      nudge: true,
      ...openSettings,
    }
  }
  // The stored one first: it has a timestamp behind it and outlived a reload.
  // It cannot be stale relative to the run — every verdict clears it unless it
  // is the one reporting a failure.
  const failure = state.status.lastError ?? runtimeFailure
  if (failure) {
    return {
      severity: 'warning',
      summary: 'Last database mirror failed',
      detail: failure,
      nudge: true,
      ...openSettings,
    }
  }
  // The run's OWN verdict, before any inference from the copy fields. A mirror
  // that refuses every run — because the database cannot name itself — is
  // otherwise indistinguishable from one waiting for its first idle moment, and
  // stays that way for as long as the condition lasts.
  if (state.status.lastOutcome === 'no-identity') {
    return {
      severity: 'warning',
      summary: 'Database mirror cannot identify this database',
      detail:
        'No copy is being written. If the app has just rebuilt its local database, this clears ' +
        'itself once it has finished syncing.',
      nudge: true,
      ...openSettings,
    }
  }
  if (!state.status.lastMirrorAt) {
    // Turned on, folder chosen, nothing copied yet. Runs wait for a genuinely
    // idle main thread with no deadline, so this can hold for a whole busy
    // session — reporting it as healthy would claim a backup that does not
    // exist. No nudge: it is the ordinary state for the first minutes after
    // turning it on, and an ambient dot for that would be crying wolf.
    return {
      severity: 'warning',
      summary: 'Database mirror has not copied yet',
      detail: 'Waiting for a quiet moment to write the first copy to the chosen folder.',
      ...openSettings,
    }
  }
  if (stalled) {
    // No error and no run: the tab has not been idle long enough to copy since
    // well before the cadence asked it to. Nothing else here can see that —
    // every field still holds the last good run's values.
    return {
      severity: 'warning',
      summary: 'Database mirror has not run recently',
      detail: `${describeLastCopy(state)}. The app has not been idle long enough to take another.`,
      nudge: true,
      ...openSettings,
    }
  }
  if (unmanagedIsPilingUp(state)) {
    // Copies the keep count does not govern have no ceiling of their own, and
    // the commonest source — entries this device cannot open, on a cloud folder
    // that evicts older files — grows by one per run with nothing pruned. The
    // folder is the user's, so this reports rather than deletes.
    return {
      severity: 'warning',
      summary: 'Database mirror folder is filling up',
      detail:
        `${state.status.unmanagedCopies ?? 0} copies in the folder are not managed by this ` +
        'device — from another device, from a database this one replaced, ones it cannot open, ' +
        'or ones taken while it could not identify the database. They are never deleted ' +
        'automatically.',
      nudge: true,
      ...openSettings,
    }
  }
  // Nothing to say. The shared chip shows only what is not `ok`, and both
  // sibling sources answer null when healthy.
  return null
}

/** Well past what a shared folder or a replaced database explains, so the only
 *  remaining explanation is a folder that is accumulating without a ceiling. */
const unmanagedIsPilingUp = (state: DbMirrorState): boolean =>
  (state.status.unmanagedCopies ?? 0) > 3 * state.settings.keepCount

/** The chip re-reads through `useSyncExternalStore`, which compares by
 *  identity — so one snapshot per (state, failure, staleness), cached. The
 *  staleness term is what makes the cache key more than the store state: it
 *  changes with the clock and nothing else would notice. */
let cachedFrom: DbMirrorState | null = null
let cachedFailure: string | undefined
let cachedStalled = false
let cached: DiagnosticSnapshot | null = null

const staleness = new CallbackSet('db-mirror-staleness')
let ticker: ReturnType<typeof setInterval> | undefined

const currentlyStalled = (): boolean => {
  const state = dbMirrorStore.getSnapshot()
  return state !== null && isMirrorStalled(state, Date.now())
}

export const dbMirrorDiagnosticSource: DiagnosticSourceContribution = {
  id: 'db-mirror',
  label: 'Database mirror',
  subscribe: (listener) => {
    const offStore = dbMirrorStore.subscribe(listener)
    const offRuntime = dbMirrorRuntimeHealth.subscribe(listener)
    const offStale = staleness.add(listener)
    // Only while something is watching, and only one timer however many are:
    // this exists to move a boolean, not to keep a tab awake.
    ticker ??= setInterval(() => {
      if (currentlyStalled() !== cachedStalled) staleness.notify()
    }, STALE_CHECK_MS)
    return () => {
      offStore()
      offRuntime()
      offStale()
      // Counted from the SET, not from a counter of our own. Every disposer
      // above is idempotent by contract, so a composite that decremented would
      // go negative on a double-call and then never reach zero again — leaving
      // this timer armed with nothing watching, for the life of the tab.
      if (staleness.size === 0 && ticker !== undefined) {
        clearInterval(ticker)
        ticker = undefined
      }
    }
  },
  getSnapshot: () => {
    const state = dbMirrorStore.getSnapshot()
    const failure = dbMirrorRuntimeHealth.getSnapshot()
    const stalled = currentlyStalled()
    if (state !== cachedFrom || failure !== cachedFailure || stalled !== cachedStalled) {
      cachedFrom = state
      cachedFailure = failure
      cachedStalled = stalled
      cached = dbMirrorDiagnostic(state, failure, stalled)
    }
    return cached
  },
}
