/**
 * The backlink sources of a target, answered for every target asked about in
 * the same microtask by ONE statement per kind of edge: the mentions (every
 * edge but those another surface owns, `edgeExclusions.ts`) or the edges of one
 * property (`{field}`, how a thread's target finds its threads). Self
 * references are excluded. This is the one place that decides
 * what a backlink source is; the filtered route (`sources.ts`) narrows it.
 *
 * The badge count and the unfiltered `backlinks.forBlock` list both come from
 * here: two projections of one statement, which keeps "3" on the badge equal
 * to the 3 rows the list shows on expand.
 *
 * The transport — coalescing, chunking, failure scope — is `readBatch.ts`.
 */

import type { QueryCtx, QueryReadDb } from '@/data/api'
import {
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  typedBlocksReferenceFieldKey,
  typedBlocksReferenceKey,
} from '@/data/invalidation'
import { ReadBatcher, readBatcherPerDb } from '@/data/internals/readBatch'
import { MAX_IDS_PER_IN_CLAUSE } from '@/data/internals/sqlBinds'
import { edgePredicate, type BacklinkEdges, type EdgePredicate } from './edgeExclusions.ts'

type Projection = 'ids' | 'count'
type Answer<P extends Projection> = P extends 'ids' ? readonly string[] : number

/** The candidate predicate is a COPY of the typed-query compiler's
 *  `referencedBy` branch plus `backlinks.forBlock`'s self filter, ordered as
 *  `created-desc` orders, with the edge predicate added. Built from the
 *  compiler's own per-target SQL instead (one `UNION ALL` arm per target), a
 *  wave measured several times slower than this `IN` list. `query.test.ts`
 *  pins the filtered list, which starts from the compiler, to the same ids in
 *  the same order.
 *
 *  Two clauses are defence in depth, kept to mirror the compiler: `b.deleted =
 *  0` (the references trigger already keeps `block_references` to live
 *  sources) and the `b.id` tiebreak (a seeded `created_at` tie came out in id
 *  order without it). */
// Each source block keeps its backlink, including a value whose owner projects the same target.
const backlinkSourcesSql = (
  targetCount: number,
  projection: Projection,
  edges: EdgePredicate,
): string => {
  const pairs = `pairs(target_id, id) AS (
    SELECT DISTINCT br.target_id, b.id
      FROM block_references br
      JOIN blocks b ON b.id = br.source_id
     WHERE br.workspace_id = ?
       AND br.target_id IN (${Array.from({length: targetCount}, () => '?').join(', ')})
       AND b.deleted = 0
       AND b.id != br.target_id
       AND (${edges.sql})
  )`
  return projection === 'count'
    ? `WITH ${pairs}
       SELECT p.target_id, COUNT(*) AS count FROM pairs p GROUP BY p.target_id`
    : `WITH ${pairs}
       SELECT p.target_id, p.id FROM pairs p JOIN blocks b ON b.id = p.id
        ORDER BY p.target_id, b.created_at DESC, b.id`
}

/** Requests one statement can answer: same workspace, projection and edges. */
interface Key {
  workspaceId: string
  projection: Projection
  edges: EdgePredicate
  edgesKey: string
}

const edgesKeyOf = (edges: EdgePredicate): string => JSON.stringify([edges.sql, edges.params])

const sameStatement = (a: Key, b: Key): boolean =>
  a.workspaceId === b.workspaceId && a.projection === b.projection &&
  a.edgesKey === b.edgesKey

export class BacklinkSourceBatcher {
  private readonly batch: ReadBatcher<Key, Answer<Projection>>

  /** `maxTargets`: one bind per target, under the shared ceiling. */
  constructor(db: QueryReadDb, maxTargets: number = MAX_IDS_PER_IN_CLAUSE) {
    this.batch = new ReadBatcher(db, {
      sameGroup: sameStatement,
      maxIdsPerStatement: maxTargets,
      read: async ({workspaceId, projection, edges}, targets) => {
        const rows = await db.getAll<{target_id: string; id?: string; count?: number}>(
          backlinkSourcesSql(targets.length, projection, edges),
          [workspaceId, ...targets, ...edges.params],
        )
        const answers = new Map<string, string[] | number>()
        for (const row of rows) {
          if (projection === 'count') answers.set(row.target_id, row.count!)
          else {
            const ids = answers.get(row.target_id) as string[] | undefined
            if (ids) ids.push(row.id!)
            else answers.set(row.target_id, [row.id!])
          }
        }
        const none = projection === 'count' ? 0 : Object.freeze([]) as readonly string[]
        return id => answers.get(id) ?? none
      },
    })
  }

  request<P extends Projection>(
    workspaceId: string,
    targetId: string,
    projection: P,
    edges: EdgePredicate,
  ): Promise<Answer<P>> {
    return this.batch.request(targetId, {
      workspaceId, projection, edges, edgesKey: edgesKeyOf(edges),
    }) as Promise<Answer<P>>
  }
}

const batcherFor = readBatcherPerDb(db => new BacklinkSourceBatcher(db))

/** Resolve one target through the batch and declare what its answer depends
 *  on: the target's reference channel, as `core.typedBlockIds` does for
 *  `referencedBy: {id}` (or, for one property's edges, that field's key). */
const resolveSources = async <P extends Projection>(
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  projection: P,
  edges: BacklinkEdges,
): Promise<Answer<P>> => {
  // One property's edges change only with that field's key; the broad
  // reference channel would re-resolve on every mention of the target too.
  ctx.depend(edges === 'mentions'
    ? {kind: 'plugin', channel: TYPED_BLOCKS_REFERENCE_CHANNEL, key: typedBlocksReferenceKey(workspaceId, targetId)}
    : {kind: 'plugin', channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, key: typedBlocksReferenceFieldKey(workspaceId, targetId, edges.field)})
  return batcherFor(ctx.db).request(
    workspaceId, targetId, projection, edgePredicate(ctx.repo, edges),
  )
}

/** Sources of `targetId` over `edges` (default: mentions), newest first, self
 *  references excluded. */
export const backlinkSourceIds = async (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  edges: BacklinkEdges = 'mentions',
): Promise<string[]> => [...await resolveSources(ctx, workspaceId, targetId, 'ids', edges)]

/** How many `backlinkSourceIds` would return, without marshalling them. */
export const backlinkSourceCount = (
  ctx: QueryCtx,
  workspaceId: string,
  targetId: string,
  edges: BacklinkEdges = 'mentions',
): Promise<number> => resolveSources(ctx, workspaceId, targetId, 'count', edges)
