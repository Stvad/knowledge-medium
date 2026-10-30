/**
 * Thread roots with their comment counts, answered for every root asked about
 * in the same microtask by ONE statement. Every rendered block resolves its
 * thread summaries in the same tick (the pill, the margin, the highlights),
 * so one read per root and one more per root's children would queue a wave's
 * worth of statements on the one- or two-connection read pool.
 *
 * Purely a transport, like `backlinks/sourceBatch.ts`: nothing resolved is
 * held between flushes. Caching is the handle store's job.
 */

import type {BlockData, QueryCtx, QueryReadDb} from '@/data/api'
import {buildQualifiedBlockColumnsSql} from '@/data/blockSchema'
import {dependOnRecognitionParams} from '@/data/internals/kernelQueries'
import {contentionFor} from '@/data/internals/timingMetrics'
import {recognizedFieldRowSql, type RecognitionParams} from '@/data/internals/treeQueries'

export interface ThreadRootRow {
  row: Record<string, unknown>
  /** The root's visible children: its top-level comments. */
  commentCount: number
}

/** Bind `[...RecognitionParams, idsJson]`: the count's placeholders come
 *  first in the text. The count is the visible-children view
 *  `core.childIds({hidePropertyChildren: true})` takes. */
const THREAD_ROOTS_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')},
         (SELECT COUNT(*) FROM blocks c
           WHERE c.parent_id = b.id AND c.deleted = 0
             AND NOT (${recognizedFieldRowSql('c')})) AS km_comment_count
    FROM json_each(?) j
    JOIN blocks b ON b.id = j.value
   WHERE b.deleted = 0
`

interface Pending {
  promise: Promise<ThreadRootRow | null>
  resolve: (answer: ThreadRootRow | null) => void
  reject: (error: unknown) => void
  callers: number
}

const pending = (): Pending => {
  let resolve!: Pending['resolve']
  let reject!: Pending['reject']
  const promise = new Promise<ThreadRootRow | null>((res, rej) => { resolve = res; reject = rej })
  return {promise, resolve, reject, callers: 1}
}

/** Requests one statement can answer: the same recognition snapshot
 *  (`registryRecognitionParams` is cached per snapshot, so identity is the
 *  comparison). */
interface Group {
  recognitionParams: RecognitionParams
  roots: Map<string, Pending>
}

export class ThreadRootBatcher {
  private groups: Group[] = []
  private scheduled = false
  private readonly pool: ReturnType<typeof contentionFor>

  constructor(private readonly db: QueryReadDb) {
    this.pool = contentionFor(db)
  }

  /** The root's row and comment count, or null for a missing or deleted row. */
  request(rootId: string, recognitionParams: RecognitionParams): Promise<ThreadRootRow | null> {
    let group = this.groups.find(g => g.recognitionParams === recognitionParams)
    if (!group) {
      group = {recognitionParams, roots: new Map()}
      this.groups.push(group)
    }
    const existing = group.roots.get(rootId)
    if (existing) {
      existing.callers++
      return existing.promise
    }
    const entry = pending()
    group.roots.set(rootId, entry)
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

  private async flushGroup({recognitionParams, roots}: Group): Promise<void> {
    let callers = 0
    for (const entry of roots.values()) callers += entry.callers
    if (callers > 1) this.pool?.noteSharedWork()
    try {
      const rows = await this.db.getAll<Record<string, unknown>>(
        THREAD_ROOTS_SQL, [...recognitionParams, JSON.stringify([...roots.keys()])],
      )
      const answers = new Map<string, ThreadRootRow>()
      for (const {km_comment_count, ...row} of rows) {
        answers.set(row.id as string, {row, commentCount: Number(km_comment_count)})
      }
      for (const [id, entry] of roots) entry.resolve(answers.get(id) ?? null)
    } catch (error) {
      for (const entry of roots.values()) entry.reject(error)
    }
  }
}

/** One batcher per read surface, which is one per `Repo`. */
const batchers = new WeakMap<QueryReadDb, ThreadRootBatcher>()

const batcherFor = (db: QueryReadDb): ThreadRootBatcher => {
  let batcher = batchers.get(db)
  if (!batcher) {
    batcher = new ThreadRootBatcher(db)
    batchers.set(db, batcher)
  }
  return batcher
}

/** The live roots among `ids`, hydrated, each with its comment count, through
 *  the batch. Declares what the count reads: each root's children and field
 *  recognition. */
export const threadRootsWithCounts = async (
  ctx: QueryCtx,
  ids: readonly string[],
): Promise<{root: BlockData; commentCount: number}[]> => {
  const recognitionParams = dependOnRecognitionParams(ctx)
  for (const id of ids) ctx.depend({kind: 'parent-edge', parentId: id})
  const batcher = batcherFor(ctx.db)
  const found = (await Promise.all(ids.map(id => batcher.request(id, recognitionParams))))
    .filter(answer => answer !== null)
  return ctx.hydrateBlocks(found.map(answer => answer.row))
    .map((root, i) => ({root, commentCount: found[i].commentCount}))
}
