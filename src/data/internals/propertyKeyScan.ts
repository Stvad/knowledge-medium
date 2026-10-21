/**
 * Which property keys in a workspace's cell data does the registry not
 * resolve, and what is each one's situation?
 *
 * Two callers need exactly this answer and must never disagree about it:
 * `audit-properties` REPORTS the keys, and §9's orphan-definition synthesis
 * MINTS definitions for them. A second copy of the classification would let
 * the report list five orphans while synthesis mints three, with nothing to
 * say which is right — so the scan lives here, once, and each caller adds
 * only its own layer (operator prose and provenance sampling on one side,
 * codec inference and the write on the other).
 *
 * COST. Uncapped by design: one full pass over the workspace's live blocks
 * (`json_each`-expanding every property bag) plus one for the unreadable
 * count and one over the definition rows. A cap would make the list
 * INCOMPLETE, which is the failure both callers exist to prevent — a partial
 * list reads as "all clear" — on an explicit operator-run command.
 */

import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertyNameProp } from '@/data/properties'
import type { PropertySchemaIdentityUnavailableReason } from '@/data/api'
import type { Repo } from '@/data/repo'

/** `json_each` raises on malformed JSON and invents keys for valid non-object
 *  JSON (integer indices for an array, a single NULL key for a scalar), so it
 *  is guarded on BOTH validity and object-ness. Without the object test, a
 *  corrupt scalar cell would surface as a phantom empty-string key — which
 *  the audit reports as a hard flip blocker and synthesis would refuse to
 *  mint for.
 *
 *  KEEP THE `CASE`, and keep the `NOT_` twin a `WHERE` conjunct. Whether
 *  SQLite short-circuits this `AND` depends on the CONTEXT, which is easy to
 *  break by accident (all verified against sqlite3 3.51):
 *    - in a `WHERE` clause it does — the row is filtered, nothing raises;
 *    - in a value-producing position (a `SELECT` list item, a computed
 *      column) it does NOT — both function opcodes run and `json_type`
 *      raises `malformed JSON`;
 *    - inside `CASE WHEN … THEN … ELSE … END` it does, because the `CASE`
 *      compiles to a real jump over the second call.
 *  So hoisting this predicate into a `SELECT` list, or dropping the `CASE`
 *  to "simplify", silently reintroduces the abort this guard prevents. */
const IS_OBJECT_BAG =
  `json_valid(b.properties_json) AND json_type(b.properties_json) = 'object'`
export const OBJECT_BAG =
  `CASE WHEN ${IS_OBJECT_BAG} THEN b.properties_json ELSE '{}' END`
/** Exact logical complement, derived from the same source so the two can
 *  never drift into disagreeing about which rows the histogram skipped. */
const NOT_OBJECT_BAG = `NOT (${IS_OBJECT_BAG})`

/** One key the workspace's registry could not resolve. */
export interface UnresolvedPropertyKey {
  property: string
  /** Occurrences of the key across live blocks. One per (block, key), so it
   *  equals the block count for any bag written through the normal path —
   *  only a hand-crafted `properties_json` with a duplicated key could make
   *  it exceed that. */
  cells: number
  /** The resolver's own verdict, so every consumer and the migration cannot
   *  disagree about what is registered. In practice a NAME lookup only ever
   *  yields `definition-unavailable`. */
  reason: PropertySchemaIdentityUnavailableReason
  /** Live `property-schema` blocks in this workspace whose EFFECTIVE name is
   *  this key. Non-zero with an unresolved name means a BROKEN definition,
   *  not a missing one — a different fix, and the one case synthesis must
   *  not mint for (a second definition would collide). Counted from `blocks`
   *  rather than from the registry: a definition whose metadata fails to
   *  parse is absent from the registry entirely, which would otherwise read
   *  as "nothing declares this name". */
  definitionBlocks: number
}

/** One scan of a workspace's property keys.
 *
 *  SCOPED TO LIVE ROWS. A key carried only by tombstones is invisible here, so
 *  it is neither a candidate nor a blocker, and a block restored after the flip
 *  comes back carrying a cell key nothing will promote. Accepted rather than
 *  fixed: counting tombstoned occurrences would mint definitions for keys that
 *  may never return, and the repair (re-run the gesture) is the same one a
 *  post-flip raw writer needs. */
export interface PropertyKeyScan {
  workspaceId: string
  /** Non-null when this device could not vouch for its view of `blocks` when
   *  the scan started. The scan happened anyway; the counts are then short by
   *  an unknown amount, and an empty `unresolved` list means nothing. */
  syncGap: string | null
  distinctProperties: number
  /** Total (block, key) pairs — the size of the cell-era property surface. */
  propertyCells: number
  registeredProperties: number
  unresolved: UnresolvedPropertyKey[]
  /** Live blocks whose `properties_json` is not a JSON object, so their keys
   *  are invisible to this scan — the result is INCOMPLETE by that many
   *  blocks rather than clean. This means LOCAL CORRUPTION; it is
   *  specifically not an e2ee artifact (ciphertext lives only in the
   *  `blocks_synced` staging table, so a row in `blocks` is always
   *  plaintext). */
  unreadableBlocks: number
}

interface HistogramRow {
  property: string | null
  cells: number
}

/** SQLite yields a non-string key only for a non-object bag, which
 *  `OBJECT_BAG` already excludes; this keeps the type honest without
 *  pretending the fallback carries meaning. */
export const keyOf = (raw: string | null): string =>
  typeof raw === 'string' ? raw : String(raw ?? '')

/** The live CELLS of a workspace: one row per (block, key), `b` the block and
 *  `j` the cell — the same implicit aliases {@link OBJECT_BAG} assumes. Binds
 *  `workspaceId` at its own position in the statement.
 *
 *  A clause, not a query, because each caller wants a different SELECT list
 *  over the same rows — a count, a DISTINCT presence pair, a windowed
 *  last-occurrence pick. What it keeps in one place is the pair of filters
 *  that decide WHICH cells are data: `OBJECT_BAG`, without which `json_each`
 *  over a non-object bag emits its indices as phantom keys, and `deleted = 0`,
 *  since this reads `blocks` with no join to exclude a tombstone. */
export const LIVE_CELLS = `
      FROM blocks b, json_each(${OBJECT_BAG}) j
     WHERE b.workspace_id = ? AND b.deleted = 0`

/** {@link LIVE_CELLS} restricted to a set of property names, passed as ONE
 *  bound JSON array so the bind count does not grow with the names. Binds
 *  `workspaceId` then `JSON.stringify(names)`, in that order. */
export const LIVE_CELLS_FOR_NAMES = `${LIVE_CELLS}
       AND j.key IN (SELECT value FROM json_each(?))`

/** Minimal read surface shared by `repo.db` and a transaction's `txDb`, so
 *  the readers below serve an in-transaction caller too. */
interface BagQuery {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/** One live `property-schema` row with its property bag already parsed. */
export interface PropertyDefinitionBag {
  id: string
  bag: Record<string, unknown>
}

/** Every live `property-schema` row in the workspace, bag parsed — the ONE
 *  place this repo reads definition rows out of `blocks`.
 *
 *  Parsed in JS rather than picked apart in SQL, which is what makes the
 *  duplicate-key rule automatic instead of hand-written at each call site. A
 *  stored bag CAN repeat a key: `JSON.stringify` cannot produce one but a raw
 *  SQL write can, and the types trigger sees only one row, so nothing rejects
 *  it. SQLite and JavaScript then disagree about what the bag says —
 *  `json_extract` yields the first occurrence, `JSON.parse` the last (verified
 *  against sqlite3 3.51). Every caller here is reconstructing what the RUNTIME
 *  reads, so `JSON.parse` is the definition, not an implementation choice.
 *
 *  It also keeps non-object cell values intact. A value read through
 *  `json_each(...).value` comes back flattened — a string unquoted, a boolean
 *  as 0/1, JSON null as NULL — so a caller that needs the stored value rather
 *  than just its presence cannot use that column.
 *
 *  Never throws: a bag that is malformed, or valid but not an object, comes
 *  back as `{}`, because a corrupt row must not abort a caller that is often
 *  investigating corruption. Every guard behind that — `OBJECT_BAG`, the parse
 *  catch, the object test — is defence in depth HERE and unpinned: the
 *  `block_types` join already excludes such a row, since the types trigger
 *  re-derives `block_types` from the bag and a non-object bag declares none
 *  (#284's disk-level corruption is the only route past that). `OBJECT_BAG`
 *  earns its place in {@link cellCountsByKey}, which has no join.
 *
 *  `b.deleted = 0` is defence in depth for the same reason — deleting a block
 *  drops its `block_types` row. */
export const readPropertyDefinitionBags = async (
  db: BagQuery,
  workspaceId: string,
): Promise<PropertyDefinitionBag[]> => {
  const rows = await db.getAll<{id: string; bag: string}>(
    `SELECT b.id AS id, ${OBJECT_BAG} AS bag
       FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = ? AND b.workspace_id = ? AND b.deleted = 0`,
    [PROPERTY_SCHEMA_TYPE, workspaceId],
  )
  return rows.map(row => {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.bag)
    } catch {
      parsed = {}
    }
    const bag = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    return {id: row.id, bag}
  })
}

/** The name a definition row claims, off its parsed bag — `undefined` when it
 *  claims none, which includes a cell holding a non-string. Only a corrupt or
 *  hand-written row has one, but every caller has to answer the same way about
 *  it, so the rule is spelled once. */
export const definitionNameOf = (
  bag: Record<string, unknown>,
): string | undefined => {
  const name = bag[propertyNameProp.name]
  return typeof name === 'string' ? name : undefined
}

/** Cells per property key on live blocks in the workspace — one row per
 *  (block, key), so a bag with a duplicated key counts twice.
 *
 *  Omitting `names` is the WHOLE histogram: the uncapped pass this file's
 *  header costs out, over every live block. Passing them restricts it, as ONE
 *  bound JSON array rather than a generated `IN` list, so the bind count does
 *  not grow with the names.
 *
 *  Both filters in {@link LIVE_CELLS} are load-bearing here, unlike in {@link
 *  readPropertyDefinitionBags} where the `block_types` join already applies
 *  them. */
export const cellCountsByKey = async (
  db: BagQuery,
  workspaceId: string,
  names?: readonly string[],
): Promise<Map<string, number>> => {
  // Not for correctness — `IN (SELECT … json_each('[]'))` already matches
  // nothing — but to skip the full `blocks` x `json_each` expansion first.
  if (names?.length === 0) return new Map()
  // One decision, not two: the clause and its parameters must agree, and a
  // wrong bind is a silently wrong answer rather than a type error.
  const scan = names === undefined
    ? {from: LIVE_CELLS, params: [workspaceId]}
    : {from: LIVE_CELLS_FOR_NAMES, params: [workspaceId, JSON.stringify(names)]}
  const rows = await db.getAll<HistogramRow>(
    `SELECT j.key AS property, COUNT(*) AS cells ${scan.from}
      GROUP BY j.key`,
    scan.params,
  )
  return new Map(rows.map(row => [keyOf(row.property), row.cells]))
}

/** The registry must belong to `workspaceId`, or every key reads as
 *  unregistered — and a caller that WRITES on that reading mints definitions
 *  for keys that already have one. */
export const requirePropertyRegistryFor = (repo: Repo, workspaceId: string) => {
  const loaded = repo.propertyDefinitions
  if (!loaded || loaded.workspaceId !== workspaceId) {
    throw new Error(
      `Cannot read property keys for ${workspaceId}: its property-definition registry is ` +
      `not loaded (loaded: ${loaded?.workspaceId ?? 'none'}). Every key would read as ` +
      'unregistered. Open that workspace in the app and re-run.',
    )
  }
  return loaded
}

/** Enumerate every property key in the workspace's live blocks and classify
 *  each against the same resolver the migration uses. */
export const scanPropertyKeys = async (
  repo: Repo,
  workspaceId: string,
): Promise<PropertyKeyScan> => {
  // Validate BEFORE the wait, not after: `whenPropertyDefinitionsReady` refuses
  // a non-active workspace with a message that names no fix. This one does.
  requirePropertyRegistryFor(repo, workspaceId)
  // The registry is DERIVED from definition blocks, so a snapshot taken
  // mid-rebuild calls a key whose definition has already landed "broken". Not
  // a proof (a definition arriving after this still lags), but that error runs
  // in the cheap direction: a false positive the operator investigates, unlike
  // an all-clear built from missing rows.
  await repo.whenPropertyDefinitionsReady(workspaceId)
  // Sampled here, above the registry capture below, so every await in this
  // function is behind us before the resolver freezes.
  //
  // A key whose definition merely failed to reach `blocks` reads as UNRESOLVED
  // here, with nothing in flight to explain it, so the survey's whole output is
  // wrong in the direction its readers act on — hence
  // {@link Repo.workspaceViewGap}, whose scan is proportionate next to the
  // survey it qualifies.
  const syncGap = (await repo.workspaceViewGap(workspaceId))?.reason ?? null
  // Defence in depth; no test pins it. A workspace switch across the awaits
  // above would leave `registry` belonging to another workspace, silently
  // degrading the effective-name rewrite below to stored names — or, past the
  // previous-workspace fallback, make `propertySchemaResolverFor` fail CLOSED,
  // which here is the HAZARD: every key resolves identity-unavailable and the
  // whole graph reads as unregistered.
  const registry = requirePropertyRegistryFor(repo, workspaceId)
  // NOTHING MAY AWAIT between this line and the scans below: the resolver
  // holds its snapshot by value, so classification is fixed the instant it's
  // taken, and a suspension point here would let a workspace switch leave the
  // scans reading rows this snapshot cannot classify.
  const resolver = repo.propertySchemaResolverFor(workspaceId)

  const histogram = await cellCountsByKey(repo.db, workspaceId)

  const unreadable = await repo.db.get<{n: number}>(
    `SELECT COUNT(*) AS n FROM blocks b
      WHERE b.workspace_id = ? AND b.deleted = 0 AND ${NOT_OBJECT_BAG}`,
    [workspaceId],
  )

  // Ground truth for "does a definition block exist for this name", read from
  // `blocks` rather than the registry: a definition whose metadata fails to
  // parse (`parsePropertyDefinitionMetadata` returns null on a bad
  // change-scope, or any decode throw) contributes NO registry entry, so the
  // registry would report zero and send the caller to synthesis — creating a
  // colliding second definition. This fallback exists precisely for rows the
  // runtime could not parse, so it has to read them the way the runtime does
  // (see `readPropertyDefinitionBags`), or it credits a broken definition to a
  // name nothing uses and mis-buckets the orphan on the other spelling.
  const definitionRows = await readPropertyDefinitionBags(repo.db, workspaceId)
  // Counted under each definition's EFFECTIVE name (the seed-rewrite rule —
  // see `effectiveDefinitionName` in propertyDefinitionSynthesis.ts), not the
  // stored one: crediting the raw column would point a genuinely orphaned key
  // at "repair the definition" instead of the synthesis it actually needs.
  // Rows the registry doesn't know (metadata that fails to parse) fall back to
  // the stored name, which is the whole reason this reads `blocks` at all.
  const definitionBlocksByName = new Map<string, number>()
  for (const row of definitionRows) {
    const effectiveName = registry.definitionsByFieldId.get(row.id)?.name
      ?? definitionNameOf(row.bag)
    if (effectiveName === undefined) continue
    definitionBlocksByName.set(effectiveName, (definitionBlocksByName.get(effectiveName) ?? 0) + 1)
  }

  const unresolved: UnresolvedPropertyKey[] = []
  let registeredProperties = 0
  let propertyCells = 0

  for (const [property, cells] of histogram) {
    propertyCells += cells

    const resolution = resolver.resolve(property)
    if (resolution.status === 'resolved') {
      registeredProperties += 1
      continue
    }

    unresolved.push({
      property,
      cells,
      reason: resolution.reason,
      definitionBlocks: definitionBlocksByName.get(property) ?? 0,
    })
  }

  unresolved.sort((left, right) =>
    right.cells - left.cells || left.property.localeCompare(right.property))

  return {
    workspaceId,
    syncGap,
    distinctProperties: histogram.size,
    propertyCells,
    registeredProperties,
    unresolved,
    unreadableBlocks: unreadable?.n ?? 0,
  }
}
