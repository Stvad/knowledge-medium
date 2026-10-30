/**
 * The backlink sources of a target, answered for every target asked about in
 * the same microtask by ONE statement per kind of edge: the mentions (every
 * edge but those another surface owns, `edgeExclusions.ts`) or the edges of one
 * property (`{field}`, how a thread's target finds its threads). Self and
 * property machinery are always excluded. This is the one place that decides
 * what a backlink source is; the filtered route (`sources.ts`) narrows it.
 *
 * Every visible block resolves its inline badge in the same tick. Issued one
 * by one, those reads queue behind each other on a pool of one or two
 * connections, and the page's own child reads queue behind them. So the badge
 * count and the unfiltered `backlinks.forBlock` list both come from here: two
 * projections of one statement, which is also what keeps "3" on the badge
 * equal to the 3 rows the list shows on expand.
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
import { dependOnRecognitionParams, registryRecognitionParams } from '@/data/internals/kernelQueries'
import { ReadBatcher, readBatcherPerDb } from '@/data/internals/readBatch'
import { MAX_IDS_PER_IN_CLAUSE } from '@/data/internals/sqlBinds'
import type { RecognitionParams } from '@/data/internals/treeQueries'
import { edgePredicate, type BacklinkEdges, type EdgePredicate } from './edgeExclusions.ts'
import { machineryInteriorCtes, workspaceHasPropertyMachinery } from './machinery.ts'

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
const backlinkSourcesSql = (
  targetCount: number,
  projection: Projection,
  excludeMachinery: boolean,
  edges: EdgePredicate,
): string => {
  const ctes = [`pairs(target_id, id) AS (
    SELECT DISTINCT br.target_id, b.id
      FROM block_references br
      JOIN blocks b ON b.id = br.source_id
     WHERE br.workspace_id = ?
       AND br.target_id IN (${Array.from({length: targetCount}, () => '?').join(', ')})
       AND b.deleted = 0
       AND b.id != br.target_id
       AND (${edges.sql})
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

/** Requests one statement can answer: same workspace, projection, edges and
 *  recognition snapshot (`registryRecognitionParams` is cached per snapshot,
 *  so identity is the comparison). */
interface Key {
  workspaceId: string
  projection: Projection
  recognitionParams: RecognitionParams
  edges: EdgePredicate
  edgesKey: string
}

const edgesKeyOf = (edges: EdgePredicate): string => JSON.stringify([edges.sql, edges.params])

const sameStatement = (a: Key, b: Key): boolean =>
  a.workspaceId === b.workspaceId && a.projection === b.projection &&
  a.recognitionParams === b.recognitionParams && a.edgesKey === b.edgesKey

export class BacklinkSourceBatcher {
  private readonly batch: ReadBatcher<Key, Resolved<Projection>>

  /** `maxTargets`: one bind per target, under the shared ceiling. */
  constructor(db: QueryReadDb, maxTargets: number = MAX_IDS_PER_IN_CLAUSE) {
    this.batch = new ReadBatcher(db, {
      sameGroup: sameStatement,
      maxIdsPerStatement: maxTargets,
      read: async ({workspaceId, projection, recognitionParams, edges}, targets) => {
        // Per statement, not per group: once per group would need a per-group
        // hook on `ReadBatcher` for this caller alone. Past the ceiling that
        // costs one cheap probe per extra chunk (a yes is cached), and a failed
        // probe fails only its own chunk.
        const machinery = await workspaceHasPropertyMachinery(db, workspaceId)
        const rows = await db.getAll<{target_id: string; id?: string; count?: number}>(
          backlinkSourcesSql(targets.length, projection, machinery, edges),
          [workspaceId, ...targets, ...edges.params, ...(machinery ? recognitionParams : [])],
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
        return id => ({value: answers.get(id) ?? none, machinery})
      },
    })
  }

  request<P extends Projection>(
    workspaceId: string,
    targetId: string,
    projection: P,
    recognitionParams: RecognitionParams,
    edges: EdgePredicate,
  ): Promise<Resolved<P>> {
    return this.batch.request(targetId, {
      workspaceId, projection, recognitionParams, edges, edgesKey: edgesKeyOf(edges),
    }) as Promise<Resolved<P>>
  }
}

const batcherFor = readBatcherPerDb(db => new BacklinkSourceBatcher(db))

/** Resolve one target through the batch and declare what its answer depends
 *  on: the target's reference channel, as `core.typedBlockIds` does for
 *  `referencedBy: {id}` (or, for one property's edges, that field's key), and
 *  field recognition whenever the exclusion ran.
 *
 *  KNOWN: the machinery exclusion walks each SOURCE's ancestry, but no
 *  dependency is declared on it. Moving a source out from under a field row,
 *  or editing an ancestor between `((D))` and `::((D))`, changes membership
 *  with nothing to invalidate on, so a mounted view stays stale until the next
 *  reference change or a reload. The honest fix is a dep per candidate source
 *  and walked ancestor, on what every visible badge counts. km-nc46. */
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
  const {value, machinery} = await batcherFor(ctx.db).request(
    workspaceId, targetId, projection, registryRecognitionParams(ctx.repo), edgePredicate(ctx.repo, edges),
  )
  if (machinery) dependOnRecognitionParams(ctx)
  return value
}

/** Sources of `targetId` over `edges` (default: mentions), newest first, self
 *  and property machinery excluded. */
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
