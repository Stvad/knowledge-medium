/**
 * Request coalescing for per-block reads: every request made in the same
 * microtask is answered by ONE statement per group of requests that can share
 * one.
 *
 * A render wave resolves one handle per visible block in the same tick. Issued
 * one by one, those reads queue behind each other on a read pool of one or two
 * connections (`OPFSCoopSyncVFS` runs one connection behind a single-slot
 * mutex), and the page's own child reads queue behind them.
 *
 * Purely a transport: it holds no answers between flushes, so nothing here can
 * serve a stale one. Caching is the handle store's job. A batcher supplies only
 * its statement, the key that decides which requests share one, and the
 * mapping from its rows to each id's answer (`ReadBatchSpec`).
 */

import type { QueryReadDb } from '@/data/api'
import { contentionFor } from './timingMetrics'

export interface ReadBatchSpec<K, A> {
  /** One statement for `ids` (after any probe it needs), all requested under
   *  `key`, giving each id's answer. The lookup is asked only for those ids;
   *  an id the rows do not name is the spec's to answer, so no caller sees
   *  `undefined`. Answers are shared by every caller of one id, so they are
   *  read-only. */
  readonly read: (key: K, ids: readonly string[]) => Promise<(id: string) => A>
  /** Whether requests under `a` and `b` can share a statement. Default `===`. */
  readonly sameGroup?: (a: K, b: K) => boolean
  /** Ids one statement may bind; past it a group is split, one statement per
   *  chunk. Unbounded by default, for a statement that binds its ids as one
   *  value. A positive integer, unchecked: every caller passes a constant. */
  readonly maxIdsPerStatement?: number
}

/** One id's pending read. Every caller for that id in a tick awaits the same
 *  promise, so settling it settles all of them. */
interface Pending<A> {
  promise: Promise<A>
  resolve: (answer: A) => void
  reject: (error: unknown) => void
  /** How many callers await this id. Counted so the flush can report ONE
   *  shared read once, rather than once per caller that joined. */
  callers: number
}

const pending = <A>(): Pending<A> => {
  let resolve!: (answer: A) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<A>((res, rej) => { resolve = res; reject = rej })
  return {promise, resolve, reject, callers: 1}
}

interface Group<K, A> {
  /** The first request's key; every other in the group is `sameGroup` to it. */
  key: K
  /** Same id twice in a tick is one read. */
  waiting: Map<string, Pending<A>>
}

const identical = <K>(a: K, b: K): boolean => a === b

export class ReadBatcher<K, A> {
  private groups: Group<K, A>[] = []
  private scheduled = false
  /** Undefined when the db was never wrapped for metrics (fixtures, tests). */
  private readonly pool: ReturnType<typeof contentionFor>
  private readonly sameGroup: (a: K, b: K) => boolean
  private readonly maxIds: number

  constructor(db: QueryReadDb, private readonly spec: ReadBatchSpec<K, A>) {
    this.pool = contentionFor(db)
    this.sameGroup = spec.sameGroup ?? identical
    this.maxIds = spec.maxIdsPerStatement ?? Infinity
  }

  request(id: string, key: K): Promise<A> {
    let group = this.groups.find(g => this.sameGroup(g.key, key))
    if (!group) {
      group = {key, waiting: new Map()}
      this.groups.push(group)
    }
    const existing = group.waiting.get(id)
    if (existing) {
      existing.callers++
      return existing.promise
    }
    const entry = pending<A>()
    group.waiting.set(id, entry)
    // Work avoided, not a correctness guard: a second flush in the same tick
    // finds the queue already drained and issues nothing.
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => { void this.flush() })
    }
    return entry.promise
  }

  private async flush(): Promise<void> {
    // Taken before the first await, so a request arriving while a statement is
    // in flight opens the NEXT batch rather than joining one already read.
    const groups = this.groups
    this.groups = []
    this.scheduled = false
    await Promise.all(groups.map(group => this.flushGroup(group)))
  }

  private async flushGroup({key, waiting}: Group<K, A>): Promise<void> {
    const ids = [...waiting.keys()]
    for (let start = 0; start < ids.length; start += this.maxIds) {
      const chunk = ids.slice(start, start + this.maxIds)
      // Callers, not ids: three resolves awaiting one id share this statement
      // exactly as three ids from three resolves do, and both are one read.
      let callers = 0
      for (const id of chunk) callers += waiting.get(id)!.callers
      // Without it every caller looks like an independent measurement of an
      // idle database, and the wall-clock they all record is ONE observation.
      // Once per STATEMENT, because that is what the counter counts.
      if (callers > 1) this.pool?.noteSharedWork()
      try {
        const answerFor = await this.spec.read(key, chunk)
        for (const id of chunk) waiting.get(id)!.resolve(answerFor(id))
      } catch (error) {
        // Scoped to the chunk: a later chunk is its own statement and still
        // gets its answers.
        for (const id of chunk) waiting.get(id)!.reject(error)
      }
    }
  }
}

/** One batcher per read surface, which is one per `Repo` — `Repo` wraps its
 *  database in a per-instance metrics proxy, so two Repos over one connection
 *  do NOT share a queue. `WeakMap` rather than a `Repo` field so a resolver
 *  holding only `ctx.db` reaches it. */
export const readBatcherPerDb = <B>(create: (db: QueryReadDb) => B): ((db: QueryReadDb) => B) => {
  const batchers = new WeakMap<QueryReadDb, B>()
  return db => {
    let batcher = batchers.get(db)
    if (!batcher) {
      batcher = create(db)
      batchers.set(db, batcher)
    }
    return batcher
  }
}
