/**
 * The backlink sources of a target, answered for every target asked about in
 * the same microtask by ONE statement per kind of edge: the mentions (every
 * edge but those another surface owns, `edgeExclusions.ts`) or the edges of one
 * property (`{field}`, how a thread's target finds its threads). Self is always
 * excluded, and an edge from inside a property subtree counts as its owner's
 * (`interiorEdgesAsOwnersSql`). This is the one place that decides what a
 * backlink source is; the filtered route (`sources.ts`) narrows it.
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
import { dependOnRecognitionParams, registryRecognitionParams } from '@/data/internals/kernelQueries'
import { ReadBatcher, readBatcherPerDb } from '@/data/internals/readBatch'
import { MAX_IDS_PER_IN_CLAUSE } from '@/data/internals/sqlBinds'
import type { RecognitionParams } from '@/data/internals/treeQueries'
import { edgePredicate, type BacklinkEdges, type EdgePredicate } from './edgeExclusions.ts'
import { machineryInteriorCtes, workspaceHasPropertyMachinery } from './machinery.ts'

type Projection = 'ids' | 'count'
type Answer<P extends Projection> = P extends 'ids' ? readonly string[] : number

/** `sources(target_id, id)`: `pairs` with each edge from inside a property
 *  subtree restated as an edge from the block holding the subtree. A property
 *  value's text is shown as part of its owner, so the owner is what links, and
 *  `UNION` is what keeps a link stated both ways to one backlink.
 *
 *  An interior edge names the owner only when that owner could state the edge
 *  itself: live along the whole walk, in this workspace, and not the target. An
 *  owner with its own property edge to the target already answered for it in
 *  `pairs`, excluded or not, so its value row cannot bring it back. Over the
 *  owner, `edges.owner` applies what `edges.sql` applied to a row of its own.
 *
 *  Bind the workspace and `edges.owner.params`, in that order, after the
 *  recognition params. */
const interiorEdgesAsOwnersSql = (edges: EdgePredicate): string => `
  sources(target_id, id) AS (
    SELECT p.target_id, p.id FROM pairs p WHERE p.id NOT IN (SELECT id FROM machinery)
    UNION
    SELECT m.target_id, m.owner_id
      FROM machinery m
      JOIN blocks o ON o.id = m.owner_id
     WHERE m.live
       AND o.deleted = 0
       AND o.workspace_id = ?
       AND o.id != m.target_id
       AND NOT EXISTS (
         SELECT 1 FROM block_references own
          WHERE own.source_id = o.id AND own.target_id = m.target_id AND own.source_field != ''
       )
       AND (${edges.owner.sql})
  )`

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
  hasMachinery: boolean,
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
  if (hasMachinery) ctes.push(machineryInteriorCtes('SELECT target_id, id FROM pairs'), interiorEdgesAsOwnersSql(edges))
  const sources = hasMachinery ? 'sources' : 'pairs'
  return projection === 'count'
    ? `WITH RECURSIVE ${ctes.join(',\n')}
       SELECT p.target_id, COUNT(*) AS count FROM ${sources} p GROUP BY p.target_id`
    : `WITH RECURSIVE ${ctes.join(',\n')}
       SELECT p.target_id, p.id FROM ${sources} p JOIN blocks b ON b.id = p.id
        ORDER BY p.target_id, b.created_at DESC, b.id`
}

interface Resolved<P extends Projection> {
  value: Answer<P>
  /** Whether property subtrees were read, i.e. whether recognition could
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
          [workspaceId, ...targets, ...edges.params, ...(machinery ? [...recognitionParams, workspaceId, ...edges.owner.params] : [])],
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
 *  field recognition whenever property subtrees were read.
 *
 *  KNOWN: naming an interior edge's owner walks each SOURCE's ancestry, but no
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

/** Sources of `targetId` over `edges` (default: mentions), newest first: never
 *  the target itself, and never a row inside a property subtree, which counts
 *  as its owner. */
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
