/**
 * Idle-deferred, marker-gated maintenance jobs for the data layer.
 *
 * `Repo` runs three one-time-per-workspace maintenance passes off the
 * cold-start critical path — ref-typed-property reprojection, workspace
 * backfills, and the reconcile rescan. This module gives them one
 * drain-barrier scheduler and one completion-marker store to share:
 *   - `PendingIdleJobs` — a pending-set drain barrier over an injectable
 *     idle scheduler. One instance per job kind so each `await*` test
 *     helper drains only its own work.
 *   - `MarkerStore` — the lazy prefixed-key set: load once, then `has` /
 *     `set` / `clear` in memory + write-through to `client_schema_state`.
 */

import { scheduleIdle } from '@/utils/scheduleIdle'
import { CallbackSet } from '@/utils/callbackSet'

/** Minimal `client_schema_state` access surface — the `PowerSyncDb`
 *  read/write calls `MarkerStore` needs, structurally typed so the store
 *  is unit-testable without a full Repo / PowerSync. */
export interface MarkerDb {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

/** Declares the calling job PARKED: it is waiting on a signal only the outside
 *  world can produce (a row that must sync, a subscription that must fire), so
 *  it is not work `drain()` can wait out. Returns the release, which every
 *  settle path must call — idempotently, so a doubled release is harmless.
 *  Handed to the job body by `PendingIdleJobs.schedule`. */
export type ParkHandle = () => () => void

interface JobState {
  /** Nesting depth of the job's open park regions; 0 means it is progressing. */
  parked: number
}

/** Tracks idle-deferred jobs so deterministic tests can wait for them.
 *  The task's promise is added to the pending set when the deferred
 *  callback fires and removed on settle. `drain` awaits everything whose
 *  timer has already fired — it does NOT advance timers, so fake-timer
 *  callers must bump the clock first. */
export class PendingIdleJobs {
  private readonly pending = new Map<Promise<void>, JobState>()
  /** Woken when any job enters a park region, so a `drain` already awaiting that
   *  job re-evaluates instead of waiting on it forever. */
  private readonly parkWaiters = new CallbackSet('PendingIdleJobs.park')

  /** @param scheduler defers a callback off the critical path. Defaults to
   *  `scheduleIdle`; pass a `scheduleDeepIdle(fn, opts)` wrapper for jobs
   *  that should run only on genuine idle, never near boot. Both share the
   *  Node/jsdom `setTimeout(0)` test path, so drain helpers are unaffected. */
  constructor(private readonly scheduler: (fn: () => void) => void = scheduleIdle) {}

  /** Defer `task` off the critical path. Fire-and-forget: the caller's path
   *  is not blocked. The promise enters the pending set only once the
   *  deferred callback runs.
   *
   *  A job owns its errors: every family here catches what it can retry from and
   *  reports it with the workspace and pass in hand. What escapes is logged and
   *  dropped, because `drain` is a barrier and not an error channel — a test that
   *  needs a failure asserts on the outcome the job was supposed to produce.
   *
   *  A job that awaits an EXTERNAL signal — a row that must sync, a gate that
   *  opens on connectivity — must either wait for that signal BEFORE scheduling
   *  (what `Repo.scheduleWorkspaceBackfills` does with its sync gate) or wrap the
   *  wait in the `ParkHandle` passed to `task`. Neither, and on a device or
   *  fixture where the signal never comes the job sits in the pending set and
   *  every `drain()` hangs — issue #1015. */
  schedule(task: (park: ParkHandle) => Promise<void>): void {
    this.scheduler(() => {
      const state: JobState = {parked: 0}
      const p = task(() => this.park(state))
        .catch((error: unknown) => {
          console.error('[PendingIdleJobs] deferred job failed:', error)
        })
        .finally(() => { this.pending.delete(p) })
      this.pending.set(p, state)
    })
  }

  /** Open a park region for `state` and wake every drain awaiting it. */
  private park(state: JobState): () => void {
    state.parked += 1
    this.parkWaiters.notify()
    let released = false
    return () => {
      if (released) return
      released = true
      state.parked -= 1
    }
  }

  /** A promise that resolves the next time any job parks. */
  private whenSomeJobParks(): {promise: Promise<void>; dispose: () => void} {
    let wake!: () => void
    const promise = new Promise<void>(resolve => { wake = resolve })
    return {promise, dispose: this.parkWaiters.add(wake)}
  }

  /** Await every job whose deferral timer has already fired AND that can still
   *  progress on its own. Loops so a job that settles while we await an earlier
   *  one is still drained.
   *
   *  NOT a settle barrier for every caller, in two ways.
   *
   *  A workspace backfill that defers on the sync gate re-arms itself, so it can
   *  enqueue a SUCCESSOR job. That successor's deferral timer has not fired yet,
   *  so this returns without it — which is what makes the loop terminate, and
   *  also why a test asserting "the pass has finished" must wait on the outcome
   *  rather than on this.
   *
   *  A job inside a `ParkHandle` region is likewise not awaited: it is blocked on
   *  something only the outside world can deliver, so awaiting it is a hang
   *  rather than a drain. Parking during the await counts too, which is why this
   *  races the pending jobs against the park signal instead of awaiting them
   *  outright.
   *
   *  Resolves whatever the jobs did — see `schedule` for where a failure goes. */
  async drain(): Promise<void> {
    for (;;) {
      const active: Promise<void>[] = []
      for (const [job, state] of this.pending) if (state.parked === 0) active.push(job)
      if (active.length === 0) return
      const parkedSignal = this.whenSomeJobParks()
      try {
        await Promise.race([Promise.all(active), parkedSignal.promise])
      } finally {
        parkedSignal.dispose()
      }
    }
  }

  get size(): number {
    return this.pending.size
  }

  /** Pending jobs currently inside a park region — what `drain()` returned
   *  without, and the only honest answer to "why did the drain not wait?". */
  get parkedSize(): number {
    let n = 0
    for (const state of this.pending.values()) if (state.parked > 0) n += 1
    return n
  }
}

/** Lazy in-memory mirror of a prefixed family of completion markers in
 *  `client_schema_state` (e.g. all `reproject_ref:%` rows). One SQL
 *  round-trip per lifetime on first access; afterwards `has` is a pure
 *  Set lookup and `set` / `clear` write through to the table while
 *  keeping the mirror coherent. Entries are stored as the key *suffix*
 *  (everything after `prefix`); callers build the suffix (the markers are
 *  per-workspace, so it's typically `<workspaceId>:<name>`). */
export class MarkerStore {
  private cache: Set<string> | null = null

  constructor(
    private readonly db: MarkerDb,
    private readonly prefix: string,
    /** `SELECT key FROM client_schema_state WHERE key LIKE '<prefix>%'`. */
    private readonly selectSql: string,
    /** `INSERT OR REPLACE INTO client_schema_state (key, …) VALUES (?, …)`
     *  — the `?` is the full (prefixed) key. */
    private readonly recordSql: string,
    /** `DELETE FROM client_schema_state WHERE key = ?`. Omit for marker
     *  families that are only ever added (e.g. workspace backfills). */
    private readonly clearSql?: string,
  ) {}

  /** Load the marker set on first call, then keep it in-memory. Legacy
   *  keys that don't share the current suffix shape load as inert entries
   *  that never match a current lookup — the caller simply re-runs once. */
  async load(): Promise<Set<string>> {
    if (this.cache !== null) return this.cache
    const rows = await this.db.getAll<{key: string}>(this.selectSql)
    const set = new Set<string>()
    for (const r of rows) set.add(r.key.slice(this.prefix.length))
    this.cache = set
    return set
  }

  async has(suffix: string): Promise<boolean> {
    return (await this.load()).has(suffix)
  }

  async set(suffix: string): Promise<void> {
    await this.db.execute(this.recordSql, [`${this.prefix}${suffix}`])
    this.cache?.add(suffix)
  }

  async clear(suffix: string): Promise<void> {
    if (!this.clearSql) {
      throw new Error('[MarkerStore] clear() called on a store without clearSql')
    }
    await this.db.execute(this.clearSql, [`${this.prefix}${suffix}`])
    this.cache?.delete(suffix)
  }

  /** Drop the in-memory mirror so the next access re-reads from the
   *  table. Used by tests / migrations that mutate the table out-of-band. */
  reset(): void {
    this.cache = null
  }
}
