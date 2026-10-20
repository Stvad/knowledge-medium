/**
 * The unfiltered backlink sources of a target, property machinery excluded,
 * answered for every target asked about in the same microtask by ONE statement.
 *
 * Every visible block resolves its inline badge in the same tick. Issued one
 * by one, those reads queue behind each other on a pool of one or two
 * connections, and the page's own child reads queue behind them. So the badge
 * count and the unfiltered `backlinks.forBlock` list both come from here: two
 * projections of one statement, which is also what keeps "3" on the badge
 * equal to the 3 rows the list shows on expand.
 *
 * Purely a transport, like `ancestorBatch.ts`: nothing resolved is held
 * between flushes. Caching is the handle store's job.
 */

import type { QueryCtx, QueryReadDb } from '@/data/api'
import {
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  typedBlocksReferenceKey,
} from '@/data/invalidation'
import { dependOnRecognitionParams, registryRecognitionParams } from '@/data/internals/kernelQueries'
import { MAX_IDS_PER_IN_CLAUSE } from '@/data/internals/sqlBinds'
import { contentionFor } from '@/data/internals/timingMetrics'
import type { RecognitionParams } from '@/data/internals/treeQueries'
import { machineryInteriorCtes, workspaceHasPropertyMachinery } from './machinery.ts'

type Projection = 'ids' | 'count'
type Answer<P extends Projection> = P extends 'ids' ? readonly string[] : number

/** The candidate predicate is a COPY of the typed-query compiler's
 *  `referencedBy` branch plus `backlinks.forBlock`'s self filter, ordered as
 *  `created-desc` orders. Built from the compiler's own per-target SQL instead
 *  (one `UNION ALL` arm per target), a wave measured several times slower than
 *  this `IN` list. The filtered list still takes the compiler's route, and
 *  `query.test.ts` pins the two to the same ids in the same order.
 *
 *  Two clauses are defence in depth, kept to mirror the compiler: `b.deleted =
 *  0` (the references trigger already keeps `block_references` to live
 *  sources) and the `b.id` tiebreak (a seeded `created_at` tie came out in id
 *  order without it). */
const backlinkSourcesSql = (
  targetCount: number,
  projection: Projection,
  excludeMachinery: boolean,
): string => {
  const ctes = [`pairs(target_id, id) AS (
    SELECT DISTINCT br.target_id, b.id
      FROM block_references br
      JOIN blocks b ON b.id = br.source_id
     WHERE br.workspace_id = ?
       AND br.target_id IN (${Array.from({length: targetCount}, () => '?').join(', ')})
       AND b.deleted = 0
       AND b.id != br.target_id
  )`]
  if (excludeMachinery) ctes.push(machineryInteriorCtes('SELECT id FROM pairs'))
  const where = excludeMachinery ? 'WHERE p.id NOT IN (SELECT id FROM machinery)' : ''
  return projection === 'count'
    ? `WITH RECURSIVE ${ctes.join(',\n')}
       SELECT p.target_id, COUNT(*) AS count FROM pairs p ${where} GROUP BY p.target_id`
    : `WITH RECURSIVE ${ctes.join(',\n')}
       SELECT p.target_id, p.id FROM pairs p JOIN blocks b ON b.id = p.id ${where}
        ORDER BY p.target_id, b.created_at DESC, b.id`
}

interface Resolved<P extends Projection> {
  value: Answer<P>
  /** Whether the machinery exclusion ran, i.e. whether recognition could
   *  change this answer. */
  machinery: boolean
}

interface Pending {
  promise: Promise<Resolved<Projection>>
  resolve: (answer: Resolved<Projection>) => void
  reject: (error: unknown) => void
  callers: number
}

/** Requests one statement can answer: same workspace, projection and
 *  recognition snapshot (`registryRecognitionParams` is cached per snapshot,
 *  so identity is the comparison). */
interface Group {
  workspaceId: string
  projection: Projection
  recognitionParams: RecognitionParams
  targets: Map<string, Pending>
}

const pending = (): Pending => {
  let resolve!: Pending['resolve']
  let reject!: Pending['reject']
  const promise = new Promise<Resolved<Projection>>((res, rej) => { resolve = res; reject = rej })
  return {promise, resolve, reject, callers: 1}
}

export class BacklinkSourceBatcher {
  private groups: Group[] = []
  private scheduled = false
  private readonly pool: ReturnType<typeof contentionFor>

  /** `maxTargets`: one bind per target, under the shared ceiling. */
  constructor(
    private readonly db: QueryReadDb,
    private readonly maxTargets: number = MAX_IDS_PER_IN_CLAUSE,
  ) {
    this.pool = contentionFor(db)
  }

  request<P extends Projection>(
    workspaceId: string,
    targetId: string,
    projection: P,
    recognitionParams: RecognitionParams,
  ): Promise<Resolved<P>> {
    let group = this.groups.find(g =>
      g.workspaceId === workspaceId && g.projection === projection &&
      g.recognitionParams === recognitionParams)
    if (!group) {
      group = {workspaceId, projection, recognitionParams, targets: new Map()}
      this.groups.push(group)
    }
    const existing = group.targets.get(targetId)
    if (existing) {
      existing.callers++
      return existing.promise as Promise<Resolved<P>>
    }
    const entry = pending()
    group.targets.set(targetId, entry)
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => { void this.flush() })
    }
    return entry.promise as Promise<Resolved<P>>
  }

  private async flush(): Promise<void> {
    // Taken before the first await, so a request arriving while a statement is
    // in flight opens the NEXT batch rather than joining one already read.
    const groups = this.groups
    this.groups = []
    this.scheduled = false
    await Promise.all(groups.map(group => this.flushGroup(group)))
  }

  private async flushGroup(group: Group): Promise<void> {
    const targets = [...group.targets.keys()]
    let machinery: boolean
    try {
      machinery = await workspaceHasPropertyMachinery(this.db, group.workspaceId)
    } catch (error) {
      for (const entry of group.targets.values()) entry.reject(error)
      return
    }
    for (let start = 0; start < targets.length; start += this.maxTargets) {
      const chunk = targets.slice(start, start + this.maxTargets)
      let callers = 0
      for (const id of chunk) callers += group.targets.get(id)!.callers
      if (callers > 1) this.pool?.noteSharedWork()
      try {
        const rows = await this.db.getAll<{target_id: string; id?: string; count?: number}>(
          backlinkSourcesSql(chunk.length, group.projection, machinery),
          [group.workspaceId, ...chunk, ...(machinery ? group.recognitionParams : [])],
        )
        const answers = new Map<string, string[] | number>()
        for (const row of rows) {
          if (group.projection === 'count') answers.set(row.target_id, row.count!)
          else {
            const ids = answers.get(row.target_id) as string[] | undefined
            if (ids) ids.push(row.id!)
            else answers.set(row.target_id, [row.id!])
          }
        }
        const none = group.projection === 'count' ? 0 : Object.freeze([]) as readonly string[]
        for (const id of chunk) {
          group.targets.get(id)!.resolve({value: answers.get(id) ?? none, machinery})
        }
      } catch (error) {
        // Scoped to the chunk: a later chunk is its own statement.
        for (const id of chunk) group.targets.get(id)!.reject(error)
      }
    }
  }
}

/** One batcher per read surface, which is one per `Repo` (see `ancestorBatch.ts`). */
const batchers = new WeakMap<QueryReadDb, BacklinkSourceBatcher>()

const batcherFor = (db: QueryReadDb): BacklinkSourceBatcher => {
  let batcher = batchers.get(db)
  if (!batcher) {
    batcher = new BacklinkSourceBatcher(db)
    batchers.set(db, batcher)
  }
  return batcher
}

/** Resolve one target through the batch and declare what its answer depends
 *  on: the reference channel, as `core.typedBlockIds` does for
 *  `referencedBy: {id}`, and field recognition whenever the exclusion ran. */
const resolveSources = async <P extends Projection>(
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  projection: P,
): Promise<Answer<P>> => {
  ctx.depend({
    kind: 'plugin',
    channel: TYPED_BLOCKS_REFERENCE_CHANNEL,
    key: typedBlocksReferenceKey(workspaceId, targetId),
  })
  const {value, machinery} = await batcherFor(ctx.db).request(
    workspaceId, targetId, projection, registryRecognitionParams(ctx.repo),
  )
  if (machinery) dependOnRecognitionParams(ctx)
  return value
}

/** Sources of `targetId`, newest first, self and property machinery excluded. */
export const backlinkSourceIds = async (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
): Promise<string[]> => [...await resolveSources(ctx, workspaceId, targetId, 'ids')]

/** How many `backlinkSourceIds` would return, without marshalling them. */
export const backlinkSourceCount = (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
): Promise<number> => resolveSources(ctx, workspaceId, targetId, 'count')
