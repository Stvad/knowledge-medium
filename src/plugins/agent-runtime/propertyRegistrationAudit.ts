/**
 * Which property keys in this workspace's data does the registry not know?
 *
 * `grainAudit`'s `unknown-property` rule answers the same question, but only
 * for the blocks carrying one extension's declared types — so a key written
 * by a plugin that never declared it, by an importer, by a raw bag write, or
 * under a name whose owner is no longer installed is invisible there. This
 * runs over every live block in the workspace instead.
 *
 * Why it matters beyond tidiness: property migration skips these silently.
 * `materializePropertyChildrenForExistingRow`
 * (`src/data/internals/propertyChildrenProcessor.ts`) does
 * `resolveNameSchema(name)` and `continue`s when nothing resolves — correct
 * behaviour (deleting the cell value would be worse), but it means an
 * unregistered key is the one class of property data a flipped workspace
 * cannot make child-backed. §9's orphan-definition synthesis is the intended
 * converter and the migration doc requires it to run BEFORE the flip, with
 * extension-owned keys claimed by their owner first — so knowing the list,
 * and which bucket each key is in, is a prerequisite for that runbook step.
 *
 * Deliberately no exemption list. `grainAudit` skips `system:*` / `agent:*`
 * to keep a per-extension report readable; here an exemption would hide keys
 * the flip still has to carry, which is the failure mode this verb exists to
 * fix. Registered keys drop out by being registered.
 *
 * WHAT THIS DOES NOT DETECT. The contract is "keys the registry does not
 * resolve", nothing wider. Two adjacent definition problems are outside it,
 * and both are invisible here rather than mis-reported:
 *   - a SHADOWED definition (two definition blocks competing for one name):
 *     the name still resolves, via the winner, so no key is listed. The
 *     loser's own block is the problem, not the key's coverage.
 *   - a seed-name COLLISION between two plugins: `indexSeeds`
 *     (`src/data/propertyDefinitionRegistry.ts:39`) drops the colliding seed
 *     before the snapshot is built, so the surviving seed resolves the name
 *     normally. The only signal is its `console.error` at registry build.
 *
 * COST. Uncapped by design: one full pass over the workspace's live blocks
 * for the key histogram (json_each-expanding every property bag) plus a
 * second for the unreadable count. The sibling `grainAudit` caps its scan
 * (`AUDIT_BLOCK_LIMIT`) because sampling a type characterises it; here a cap
 * would make the coverage list INCOMPLETE, which is exactly the failure this
 * verb exists to fix — a partial list reading as "all clear" is worse than
 * no list. Measured at ~356k cells / ~55k blocks this is a few hundred ms of
 * native SQLite and more under wa-sqlite/OPFS, on an explicit operator-run
 * command. Only the provenance pass is sampled, and it says so.
 */

import type { PropertySchemaIdentityUnavailableReason } from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { propertyNameProp } from '@/data/properties'
import type { Repo } from '@/data/repo'

export interface UnregisteredPropertyTypeUsage {
  /** A type carried by blocks holding this key. */
  type: string
  /** Sampled blocks with this type — NOT the workspace-wide total. Bounded
   *  by the provenance sample (see `PROVENANCE_BLOCKS_PER_KEY`); `cells` is
   *  the exact count. */
  sampledBlocks: number
}

export interface UnregisteredProperty {
  property: string
  /** Occurrences of the key across live blocks. One per (block, key), so it
   *  equals the block count for any bag written through the normal path —
   *  only a hand-crafted `properties_json` with a duplicated key could make
   *  it exceed that. */
  cells: number
  /** The resolver's own verdict, so this report and the migration cannot
   *  disagree about what is registered. In practice a NAME lookup only ever
   *  yields `definition-unavailable` — see `describeUnregisteredProperty`. */
  reason: PropertySchemaIdentityUnavailableReason
  /** Live `property-schema` blocks in this workspace whose stored name is
   *  this key. Non-zero with an unresolved name means a BROKEN definition,
   *  not a missing one — a different fix, so this is counted from `blocks`
   *  rather than from the registry (a definition whose metadata fails to
   *  parse is absent from the registry entirely, which would otherwise read
   *  as "nothing declares this name" and invite a colliding second one). */
  definitionBlocks: number
  /** What to do about it, in the order §9 requires. */
  fix: string
  /** Set when no definition can ever back the key, so the flip must not
   *  proceed until it is remapped or deleted. */
  blocksFlip?: true
  /** Types carried by a SAMPLE of the blocks holding the key — the
   *  machine-readable hint about which extension wrote it. Blocks with no
   *  type contribute nothing here. */
  types: UnregisteredPropertyTypeUsage[]
  sampleBlockIds: string[]
  /** No provenance was read for this key (the key cap below). Its `cells`
   *  count is still exact. */
  provenanceOmitted?: true
}

/** POINT IN TIME, not a snapshot. The passes below are separate reads, so a
 *  write landing mid-audit can skew them against each other (a block created
 *  after the histogram can appear in `sampleBlockIds` without contributing to
 *  `cells`; a concurrent delete can leave a count with no provenance). Not
 *  worth fixing here: `PowerSyncDb` exposes no read-snapshot primitive, and
 *  its only transaction is `writeTransaction` — taking a write lock across a
 *  full-workspace scan would stall the live app and break this verb's
 *  read-only contract to tidy an advisory report that is re-run for free.
 *  The counts describe a slow-moving property of the graph (which keys have
 *  definitions), so skew is self-correcting on the next run. */
export interface PropertyRegistrationAudit {
  workspaceId: string
  /** Non-null when this device's view of `blocks` was already incomplete when
   *  the scan started — still downloading, or rows staged and not yet drained.
   *  The scan happened anyway; the counts are then short by an unknown amount,
   *  and an empty `unregistered` list means nothing.
   *
   *  Reported rather than refused: this verb reads, and the flip is what acts
   *  on what it says. Guarding the irreversible step is worth machinery;
   *  guarding a report an operator chose to run is worth a sentence. */
  syncGap: string | null
  /** When this device last completed a sync, or null if it never has (or there
   *  is no sync layer). The rest of the report's basis, and the part no check
   *  can establish: `syncGap` being null says nothing is outstanding LOCALLY,
   *  never that the server has nothing this device has not been told about. A
   *  `syncedThrough` from days ago on a connected client is the cue that the
   *  scan ran over stale rows. */
  syncedThrough: string | null
  distinctProperties: number
  /** Total (block, key) pairs — the size of the cell-era property surface. */
  propertyCells: number
  registeredProperties: number
  unregistered: UnregisteredProperty[]
  unregisteredCells: number
  /** Live blocks whose `properties_json` is not a JSON object, so their keys
   *  are invisible to this audit — the report is INCOMPLETE by that many
   *  blocks rather than clean.
   *
   *  This means LOCAL CORRUPTION. It is specifically not an e2ee artifact:
   *  ciphertext only ever lives in the `blocks_synced` staging table (which
   *  is "never read by app queries", `src/data/blockSchema.ts`) and an
   *  undecryptable row is quarantined there rather than materialized, so a
   *  row in `blocks` is always plaintext. Do not wave a non-zero count off.
   *  (A locked or still-draining e2ee workspace is a different kind of
   *  incompleteness — those blocks are ABSENT from `blocks`, so nothing
   *  here can see them.) */
  unreadableBlocks: number
}

/** Keys we read provenance (types + samples) for, highest cell count first.
 *  Classification and `cells` cover every key regardless; this bounds only
 *  the second pass, which touches individual blocks. */
export const PROVENANCE_KEY_LIMIT = 50
/** Blocks sampled per key for provenance. A key on 200k blocks doesn't need
 *  200k of them to say which extension wrote it, and the cap must be
 *  PER-KEY and applied before the per-row type lookup — a global `LIMIT`
 *  after an `ORDER BY` doesn't bound the work, it just trims the output. */
export const PROVENANCE_BLOCKS_PER_KEY = 25
/** Sample block ids kept per key — enough to open one and see the shape. */
const SAMPLES_PER_KEY = 3

/** `json_each` raises on malformed JSON and invents keys for valid non-object
 *  JSON (integer indices for an array, a single NULL key for a scalar), so it
 *  is guarded on BOTH validity and object-ness. Without the object test, a
 *  corrupt scalar cell would surface as a phantom empty-string key and be
 *  reported as a hard flip blocker.
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
const OBJECT_BAG = `CASE WHEN ${IS_OBJECT_BAG} THEN b.properties_json ELSE '{}' END`
/** Exact logical complement, derived from the same source so the two can
 *  never drift into disagreeing about which rows the histogram skipped. */
const NOT_OBJECT_BAG = `NOT (${IS_OBJECT_BAG})`

const undeclaredFix =
  'Nothing declares this name — no definition block, no code seed — so property ' +
  'migration skips it (propertyChildrenProcessor.ts: `resolveNameSchema` → `continue`) ' +
  'and it is the one class of property data a flipped workspace cannot make ' +
  'child-backed. Fix IN THIS ORDER: (1) if an extension owns the key, install / ' +
  'enable it so its seed materializes the definition; (2) only then let §9 orphan ' +
  'synthesis mint a user-origin definition. Synthesizing first and enabling the ' +
  'owner later collides in the winner machinery and strands field rows on the ' +
  "loser's fieldId. Registering is additive — no cell value is rewritten."

const brokenDefinitionFix =
  'A definition block exists for this name but the workspace cannot build behavior ' +
  'from it, so it registers no schema and the name resolves to nothing. Check IN ' +
  'THIS ORDER: (1) is its preset contributed by an extension that is not installed / ' +
  'enabled / loaded here? `tryBuildSchema` returns nothing for an unknown preset id, ' +
  'and the definition is then perfectly valid — enabling the provider fixes it, while ' +
  'editing the block would destroy a working preset config; (2) only if the provider ' +
  'IS loaded, repair the block itself (config the codec rejects, or metadata that ' +
  'fails to parse). Either way do not add a second definition for this name — it ' +
  'would collide.'

const emptyKeyFix =
  'The empty property key is a hard flip blocker: no definition can ever back it. ' +
  'Delete or remap it before any workspace flips to child-backed properties (§9).'

/** Reason → what to do.
 *
 *  Only `definition-unavailable` is reachable through this module: it asks the
 *  resolver by NAME, and `resolveName`
 *  (`src/data/internals/propertySchemaResolution.ts`) cannot return the other
 *  two. `shadowed` requires resolving a non-winner's own fieldId directly —
 *  a name always routes to its group head, so the head trivially matches
 *  itself. `ambiguous` requires two same-name seeds surviving into the
 *  snapshot, but `indexSeeds` `continue`s past the collider before adding it
 *  to `seedsByKey`, so at most one survives per name. The repo's own fuzz
 *  suite pins both (`propertyDefinitionRegistry.fuzz.test.ts`).
 *
 *  The remaining branches are therefore DEFENCE IN DEPTH over the reason
 *  enum, not live operator guidance — kept so a future resolver change
 *  surfaces as a real message instead of falling through to the wrong one.
 *  Pure, so each branch is testable without manufacturing a broken registry. */
export const describeUnregisteredProperty = (
  entry: {
    property: string
    reason: PropertySchemaIdentityUnavailableReason
    definitionBlocks: number
  },
): {fix: string; blocksFlip?: true} => {
  if (entry.property === '') return {fix: emptyKeyFix, blocksFlip: true}
  if (entry.reason === 'ambiguous') {
    return {fix:
      'Unreachable via a name lookup (see describeUnregisteredProperty). Two code ' +
      'seeds declaring one name would leave only the first in the registry; ' +
      'namespace one of them (`myplugin:name`).'}
  }
  if (entry.reason === 'shadowed') {
    return {fix:
      'Unreachable via a name lookup (see describeUnregisteredProperty). A ' +
      'non-winning definition block for this name would be shadowed by the ' +
      'winner; retire or rename the loser rather than adding another definition.'}
  }
  // 'registry-not-workspace-keyed' is ruled out by the caller's guard, which
  // refuses a workspace whose registry isn't loaded; treat it as unbuildable.
  return {fix: entry.definitionBlocks > 0 ? brokenDefinitionFix : undeclaredFix}
}

interface HistogramRow {
  property: string | null
  cells: number
}

interface ProvenanceRow {
  property: string | null
  blockId: string
  types: string | null
}

const parseTypes = (json: string | null): string[] => {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** SQLite yields a non-string key only for a non-object bag, which
 *  `OBJECT_BAG` already excludes; this keeps the type honest without
 *  pretending the fallback carries meaning. */
const keyOf = (raw: string | null): string => typeof raw === 'string' ? raw : String(raw ?? '')

/** Enumerate every property key in the workspace's live blocks and classify
 *  each against the same resolver the migration uses. */
export const auditPropertyRegistration = async (
  repo: Repo,
  workspaceId: string,
  limits: {keys?: number; blocksPerKey?: number} = {},
): Promise<PropertyRegistrationAudit> => {
  // Validate, wait for the projector, validate again, then capture the
  // resolver with no further `await` before the scans.
  //
  // The FIRST validation has to precede the wait, not follow it:
  // `whenPropertyDefinitionsReady` refuses a workspace that is not active with
  // its own message, which names no fix. This one does.
  //
  // The wait: the registry is DERIVED from definition blocks, so a snapshot
  // taken mid-rebuild calls a key whose definition has already landed
  // "broken". Not a proof — a definition arriving later still lags — but that
  // error runs in the cheap direction: a false positive the operator
  // investigates and re-runs, unlike a missing-rows all-clear.
  //
  // The capture: `propertySchemaResolverFor` fails CLOSED for a workspace that
  // is neither active nor immediately-previous, so a workspace switch during
  // the queries below would report the whole graph as unregistered — a false
  // list that reads authoritative and could talk someone into synthesizing
  // definitions for keys that already have them. The resolver holds its
  // snapshot by value, so taking it here makes the classification immune. Same
  // rule as `schedulePropertyDefinitionMigrations` in `repo.ts`.
  const requireRegistry = () => {
    const loaded = repo.propertyDefinitions
    if (!loaded || loaded.workspaceId !== workspaceId) {
      throw new Error(
        `Cannot audit ${workspaceId}: its property-definition registry is not loaded ` +
        `(loaded: ${loaded?.workspaceId ?? 'none'}). Classification would read every key ` +
        'as unregistered. Open that workspace in the app and re-run.',
      )
    }
    return loaded
  }
  requireRegistry()
  await repo.whenPropertyDefinitionsReady(workspaceId)
  const registry = requireRegistry()
  const resolver = repo.propertySchemaResolverFor(workspaceId)

  // Sampled, not enforced. This verb READS; it is the flip that acts on what
  // it says, and a refusal belongs on the irreversible step rather than on the
  // report. So the scan runs and states its basis: an operator who sees rows
  // still draining knows the counts are short and re-runs.
  const syncGap = await repo.syncViewGap()

  const histogram = await repo.db.getAll<HistogramRow>(
    `SELECT j.key AS property, COUNT(*) AS cells
       FROM blocks b, json_each(${OBJECT_BAG}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
      GROUP BY j.key`,
    [workspaceId],
  )

  const unreadable = await repo.db.get<{n: number}>(
    `SELECT COUNT(*) AS n FROM blocks b
      WHERE b.workspace_id = ? AND b.deleted = 0 AND ${NOT_OBJECT_BAG}`,
    [workspaceId],
  )

  // Ground truth for "does a definition block exist for this name", read from
  // `blocks` rather than the registry: a definition whose metadata fails to
  // parse (`parsePropertyDefinitionMetadata` returns null on a bad
  // change-scope, or any decode throw) contributes NO registry entry, so the
  // registry would report zero and send the operator to synthesis — creating
  // the colliding second definition `brokenDefinitionFix` warns about.
  // Same object guard as the histogram. `json_extract` RAISES on malformed
  // JSON, which would abort the whole audit — and the one time you most want
  // this report is while investigating corruption, so it must degrade into an
  // incomplete report (with `unreadableBlocks` non-zero) rather than die.
  //
  // Defence in depth for the malformed case specifically, not a live path:
  // the `blocks` update triggers run `json_each(NEW.properties_json, ...)`
  // themselves (`clientSchema.ts`), so SQLite rejects a malformed write
  // before it lands and no SQL path can create such a row. Only disk-level
  // corruption (issue #284), which never runs the triggers, can — and it can
  // leave a stale `block_types` entry pointing at the corrupt row, which is
  // what would drag it into this join. The valid-but-non-object case IS
  // reachable and is what the guard handles day to day.
  const definitionRows = await repo.db.getAll<{id: string; name: string | null}>(
    `SELECT b.id AS id, json_extract(${OBJECT_BAG}, ?) AS name
       FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = ? AND b.workspace_id = ? AND b.deleted = 0`,
    [`$."${propertyNameProp.name}"`, PROPERTY_SCHEMA_TYPE, workspaceId],
  )
  // Count each definition under its EFFECTIVE name, which is not always the
  // stored one. `buildPropertyDefinitionRegistry` rewrites a seed-backed
  // row's name to the seed's DECLARED name when the stored value has drifted
  // (older client, import, sync). Counting the raw column would credit such a
  // block to the stale key, so a cell still using that key — genuinely
  // orphaned — would be told to "repair the definition" and steered away from
  // the synthesis it actually needs, while the definition is in fact fine.
  // Rows the registry doesn't know (metadata that fails to parse) fall back
  // to the stored name, which is the whole reason this reads `blocks` at all.
  const definitionBlocksByName = new Map<string, number>()
  for (const row of definitionRows) {
    const effectiveName = registry.definitionsByFieldId.get(row.id)?.name
      ?? (typeof row.name === 'string' ? row.name : undefined)
    if (effectiveName === undefined) continue
    definitionBlocksByName.set(effectiveName, (definitionBlocksByName.get(effectiveName) ?? 0) + 1)
  }

  const unregistered: UnregisteredProperty[] = []
  let registeredProperties = 0
  let propertyCells = 0

  for (const row of histogram) {
    const property = keyOf(row.property)
    propertyCells += row.cells

    const resolution = resolver.resolve(property)
    if (resolution.status === 'resolved') {
      registeredProperties += 1
      continue
    }

    const definitionBlocks = definitionBlocksByName.get(property) ?? 0
    unregistered.push({
      property,
      cells: row.cells,
      reason: resolution.reason,
      definitionBlocks,
      ...describeUnregisteredProperty({property, reason: resolution.reason, definitionBlocks}),
      types: [],
      sampleBlockIds: [],
    })
  }

  unregistered.sort((left, right) =>
    right.cells - left.cells || left.property.localeCompare(right.property))

  // Clamp rather than trust. `rn` starts at 1, so `blocksPerKey: 0` would
  // filter EVERY provenance row while leaving `provenanceOmitted` unset —
  // every in-cap key would read as "sampled, genuinely no types" when in
  // fact nothing was sampled. A negative `keys` is worse than useless too:
  // `slice(0, -1)` keeps all-but-the-last rather than meaning "none".
  await attachProvenance(repo, workspaceId, unregistered, {
    keys: Math.max(0, Math.floor(limits.keys ?? PROVENANCE_KEY_LIMIT)),
    blocksPerKey: Math.max(1, Math.floor(limits.blocksPerKey ?? PROVENANCE_BLOCKS_PER_KEY)),
  })

  return {
    workspaceId,
    syncGap,
    syncedThrough: repo.lastSyncedAt?.toISOString() ?? null,
    distinctProperties: histogram.length,
    propertyCells,
    registeredProperties,
    unregistered,
    unregisteredCells: unregistered.reduce((sum, entry) => sum + entry.cells, 0),
    unreadableBlocks: unreadable?.n ?? 0,
  }
}

/** Second pass: for the top keys, a sample of the blocks carrying them and
 *  what types those blocks have. Mutates `unregistered` in place — the
 *  first pass's counts stay authoritative, so a sampled provenance read
 *  degrades detail without ever making the report look cleaner than it is.
 *
 *  The per-key cap is applied by `ROW_NUMBER` in a subquery so the outer
 *  `json_group_array` type lookup runs only for rows that survive it. A
 *  global `LIMIT` after `ORDER BY` would not do this: SQLite materializes and
 *  sorts every matching row first, running the per-row subquery on all of
 *  them, and the cap would only trim what came back. */
const attachProvenance = async (
  repo: Repo,
  workspaceId: string,
  unregistered: UnregisteredProperty[],
  limits: {keys: number; blocksPerKey: number},
): Promise<void> => {
  const targeted = unregistered.slice(0, limits.keys)
  for (const entry of unregistered.slice(limits.keys)) entry.provenanceOmitted = true
  if (targeted.length === 0) return

  const rows = await repo.db.getAll<ProvenanceRow>(
    `SELECT ranked.property AS property,
            ranked.blockId AS blockId,
            (SELECT json_group_array(bt.type) FROM block_types bt
              WHERE bt.block_id = ranked.blockId AND bt.workspace_id = ?) AS types
       FROM (
         SELECT property, blockId,
                ROW_NUMBER() OVER (PARTITION BY property ORDER BY blockId) AS rn
           FROM (
             -- DISTINCT because a stored bag CAN repeat a key: JSON.stringify
             -- cannot produce one, but a raw SQL write can, and the types
             -- trigger sees only one row so nothing rejects it. Without this,
             -- json_each emits a row per occurrence and one block could eat
             -- the whole per-key cap: repeating in sampleBlockIds, inflating
             -- sampledBlocks, and hiding the blocks that actually differ.
             SELECT DISTINCT j.key AS property, b.id AS blockId
               FROM blocks b, json_each(${OBJECT_BAG}) j
              WHERE b.workspace_id = ? AND b.deleted = 0
                AND j.key IN (SELECT value FROM json_each(?))
           )
       ) ranked
      WHERE ranked.rn <= ?`,
    [
      workspaceId,
      workspaceId,
      JSON.stringify(targeted.map(entry => entry.property)),
      limits.blocksPerKey,
    ],
  )

  const typeCounts = new Map<string, Map<string, number>>()
  const samples = new Map<string, string[]>()
  for (const row of rows) {
    const property = keyOf(row.property)
    const sampled = samples.get(property) ?? []
    if (sampled.length < SAMPLES_PER_KEY) {
      sampled.push(row.blockId)
      samples.set(property, sampled)
    }
    const counts = typeCounts.get(property) ?? new Map<string, number>()
    for (const type of parseTypes(row.types)) counts.set(type, (counts.get(type) ?? 0) + 1)
    typeCounts.set(property, counts)
  }

  for (const entry of targeted) {
    entry.sampleBlockIds = samples.get(entry.property) ?? []
    entry.types = [...(typeCounts.get(entry.property) ?? new Map())]
      .map(([type, sampledBlocks]) => ({type, sampledBlocks}))
      .sort((left, right) =>
        right.sampledBlocks - left.sampledBlocks || left.type.localeCompare(right.type))
  }
}
