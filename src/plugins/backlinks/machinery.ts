import { recognizedFieldRowSql, type RecognitionParams } from '@/data/internals/treeQueries'

/** The seed `IN (?, …)` list binds one variable per source id, so a heavily
 *  backlinked block must be chunked under SQLite's `SQLITE_MAX_VARIABLE_NUMBER`
 *  (999 on older builds, 32766 since 3.32) — the same discipline the sync
 *  observer's staging reads use (`materialize.ts`). 500 keeps a wide margin. */
const MACHINERY_SOURCE_CHUNK = 500

type ProbeDb = { getOptional<T>(sql: string, params?: unknown[]): Promise<T | null> }

/** Keyed by the read surface rather than held on `Repo` so the probe stays
 *  callable from a resolver holding only `ctx.db` (as `ancestorWalk` does). */
const workspacesWithMachinery = new WeakMap<ProbeDb, Set<string>>()

/** Does this workspace hold ANY property machinery at all?
 *
 *  Data-keyed, not flip-gated — it asks about the rows that exist, so a
 *  backfilled pre-flip workspace answers yes and a flipped one that has never
 *  been backfilled answers no. One indexed probe (`idx_blocks_any_field_form`).
 *
 *  THE RULE: a fast path must never be able to say NO where the slow path
 *  would say YES. Everything below follows from it.
 *
 *  So this is deliberately an OVER-approximation — the `::` bit is syntax
 *  alone, while recognition also wants a non-null parent and a resolving
 *  definition. A workspace whose only marked row is a hand-authored
 *  `::((someBlock))` therefore answers yes and gives up the aggregate path it
 *  could have kept. That is the safe error, and it costs only the optimization
 *  — the same work every flipped workspace already did before this probe
 *  existed. Do NOT "tighten" it to full recognition: that makes a second copy
 *  of a predicate which must never be NARROWER than the first, and a drift in
 *  that direction silently stops filtering instead of merely costing time.
 *  (It is also slower, not faster: the partial index requires the WHERE to
 *  syntactically prove `is_field_form = 1`, which `recognizedFieldRowSql`'s
 *  NULL-safe `COALESCE(...) = 1` does not, so the exact form drops to a full
 *  workspace scan — measured 8.3ms against 0.001ms on 200k rows.)
 *
 *  TOMBSTONES COUNT for the same rule, which is why this is not the live
 *  `idx_blocks_field_form`. Recognition never filters `deleted` — descent is
 *  structural, and sync-apply permits a live child under a tombstoned parent —
 *  so a value row whose only field ancestor is tombstoned IS machinery to the
 *  walk, and probing live rows only would answer "nothing here" and skip the
 *  filter over the very rows it exists to catch.
 *
 *  Its job is to keep the machinery filters from doing work that provably
 *  finds nothing: the ancestor walk below, on its own and inside the inline
 *  badges' batched statement. On a graph with no field rows it is
 *  guaranteed-empty, and every outline render was paying for it.
 *
 *  STALENESS: like the filters themselves this declares no dependency, so a
 *  mounted view can hold the fast path past the moment a workspace first grows
 *  machinery (km-z2bk). That moment is a backfill writing hundreds of
 *  thousands of rows, whose invalidation traffic no mounted view outlives —
 *  and it is the same dependency gap the filters already have, not a new one.
 *
 *  A YES is remembered per read surface (one per `Repo`) and workspace, so a
 *  machinery workspace pays for the probe once rather than on every wave of
 *  inline badges (`sourceBatch.ts`) and every filtered or grouped backlinks
 *  resolve. Remembering it obeys THE RULE: a stale yes only sends a caller
 *  down the filtering path, which finds nothing to drop and returns what the
 *  fast path would. It goes stale only when every marked row,
 *  tombstones included, is physically removed (a sync-applied delete), and
 *  lasts until the Repo is rebuilt. A NO is never remembered — a backfill can
 *  mint machinery at any moment.
 */
export const workspaceHasPropertyMachinery = async (
  db: ProbeDb,
  workspaceId: string,
): Promise<boolean> => {
  if (workspacesWithMachinery.get(db)?.has(workspaceId)) return true
  const found = (await db.getOptional(
    `SELECT 1 AS one FROM blocks
      WHERE workspace_id = ? AND is_field_form = 1 LIMIT 1`,
    [workspaceId],
  )) !== null
  if (found) {
    const known = workspacesWithMachinery.get(db)
    if (known) known.add(workspaceId)
    else workspacesWithMachinery.set(db, new Set([workspaceId]))
  }
  return found
}

/** Two CTEs for a `WITH RECURSIVE` list, `up` and `machinery(id)`. `machinery`
 *  holds the ids among `seedIdsSql` (anything `IN (…)` accepts: placeholders or
 *  a subquery) that are property-subtree INTERIOR machinery — a value child, or
 *  a row deeper inside a property subtree, whose parent chain passes through a
 *  §9 field row. Recognition IS `recognizedFieldRowSql`, shared with the
 *  outline rather than restated: the walk hoists the four columns the fragment
 *  reads under the names it expects, so parity is structural. Do not inline a
 *  copy here — the two predicates disagreeing is silent in both directions,
 *  dropping real backlinks or leaking duplicate ones.
 *
 *  Bind `RecognitionParams` after every placeholder in `seedIdsSql`: the
 *  fragment's parameters sit textually after the seed.
 *
 *  STRICTLY INTERIOR (`depth > 0`): the field row ITSELF is deliberately NOT
 *  matched. The de-dup this filter exists for only applies to interiors — a
 *  value row's `[[X]]` duplicates the owner's reprojected `O --prop--> X`, so
 *  showing both would state one fact twice and attribute a copy to a hidden
 *  row. A field row has no such duplicate: its only edge is to its OWN
 *  definition, which is the "used by" backlink (every block using this
 *  property), and nothing else projects that edge. Suppressing it would make a
 *  property definition's backlinks empty — the opposite of why field rows were
 *  put in `block_references` in the first place.
 *
 *  NOT flip-gated, and callers must not gate it either. `reference_target_id`
 *  derivation and `property-schema` types both exist independent of the flip,
 *  and so — since the cell→children backfill — do the field and value rows
 *  themselves. The `::` bit is what disambiguates machinery from an ordinary
 *  `((definitionId))` reference; the flip column never did, it only deferred
 *  the question to a moment when field rows were known to exist.
 *
 *  The `up` walk carries the same per-seed `path` visited-guard as
 *  `manyAncestorsSql` (treeQueries.ts) — issue #404 item 8b: without it a
 *  cyclic `parent_id` chain (issue #183) still terminates on `depth < 100`,
 *  but re-emits every cycle member on each loop iteration instead of
 *  stopping the moment a walk revisits a row it's already seen. */
export const machineryInteriorCtes = (seedIdsSql: string): string => `
  up(start_id, id, reference_target_id, is_field_form, parent_id, workspace_id, path, depth) AS (
    SELECT id, id, reference_target_id, is_field_form, parent_id, workspace_id,
           '!' || hex(id) || '/',
           0
      FROM blocks WHERE id IN (${seedIdsSql})
    UNION ALL
    SELECT up.start_id, b.id, b.reference_target_id, b.is_field_form, b.parent_id, b.workspace_id,
           up.path || '!' || hex(b.id) || '/',
           up.depth + 1
      FROM blocks AS b JOIN up ON b.id = up.parent_id
     WHERE up.depth < 100
       AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
  ),
  machinery(id) AS (
    SELECT DISTINCT up.start_id
      FROM up
     WHERE up.depth > 0
       AND (${recognizedFieldRowSql('up')})
  )`

/** Which of `sourceIds` are property machinery (`machineryInteriorCtes`). */
export const propertyMachinerySourceIds = async (
  db: { getAll<T>(sql: string, params?: unknown[]): Promise<T[]> },
  sourceIds: readonly string[],
  recognitionParams: RecognitionParams,
  chunkSize: number = MACHINERY_SOURCE_CHUNK,
): Promise<Set<string>> => {
  const machinery = new Set<string>()
  for (let i = 0; i < sourceIds.length; i += chunkSize) {
    const chunk = sourceIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await db.getAll<{ id: string }>(
      `WITH RECURSIVE ${machineryInteriorCtes(placeholders)} SELECT id FROM machinery`,
      [...chunk, ...recognitionParams],
    )
    for (const r of rows) machinery.add(r.id)
  }
  return machinery
}
