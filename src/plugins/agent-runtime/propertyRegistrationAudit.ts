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

export interface PropertyRegistrationAudit {
  workspaceId: string
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
 *  is guarded on BOTH validity and object-ness. Guarding inside the argument
 *  makes the skip evaluation-order independent rather than relying on a
 *  `WHERE` term being applied first. Without the object test, a corrupt
 *  scalar cell would surface as a phantom empty-string key and be reported as
 *  a hard flip blocker. */
const OBJECT_BAG = `CASE WHEN json_valid(b.properties_json) AND json_type(b.properties_json) = 'object'
                        THEN b.properties_json ELSE '{}' END`
/** The same predicate, for counting the rows the guard excludes. */
const NOT_OBJECT_BAG =
  `NOT (json_valid(properties_json) AND json_type(properties_json) = 'object')`

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
  'from it (unknown preset, config the codec rejects, or metadata that fails to ' +
  'parse), so it registers no schema and the name resolves to nothing. Repair that ' +
  'definition block — adding a second one for the same name would collide.'

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
  // Capture the registry AND the resolver up front, before any `await`.
  //
  // Two reasons. (1) `propertySchemaResolverFor` fails CLOSED for a workspace
  // that is neither active nor immediately-previous — every name resolves to
  // identity-unavailable, so auditing through it would report the whole graph
  // as unregistered: a false list that reads authoritative and could talk
  // someone into synthesizing definitions for keys that already have them.
  // (2) This runs against the LIVE client, where the user can switch
  // workspaces during the queries below; the resolver holds its snapshot by
  // value, so taking it here makes the classification immune to that. Same
  // rule as `schedulePropertyDefinitionMigrations` in `repo.ts` — resolve
  // now, not when the later work runs.
  const registry = repo.propertyDefinitions
  if (!registry || registry.workspaceId !== workspaceId) {
    throw new Error(
      `Cannot audit ${workspaceId}: its property-definition registry is not loaded ` +
      `(loaded: ${registry?.workspaceId ?? 'none'}). Classification would read every key ` +
      'as unregistered. Open that workspace in the app and re-run.',
    )
  }
  const resolver = repo.propertySchemaResolverFor(workspaceId)

  const histogram = await repo.db.getAll<HistogramRow>(
    `SELECT j.key AS property, COUNT(*) AS cells
       FROM blocks b, json_each(${OBJECT_BAG}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
      GROUP BY j.key`,
    [workspaceId],
  )

  const unreadable = await repo.db.get<{n: number}>(
    `SELECT COUNT(*) AS n FROM blocks
      WHERE workspace_id = ? AND deleted = 0 AND ${NOT_OBJECT_BAG}`,
    [workspaceId],
  )

  // Ground truth for "does a definition block exist for this name", read from
  // `blocks` rather than the registry: a definition whose metadata fails to
  // parse (`parsePropertyDefinitionMetadata` returns null on a bad
  // change-scope, or any decode throw) contributes NO registry entry, so the
  // registry would report zero and send the operator to synthesis — creating
  // the colliding second definition `brokenDefinitionFix` warns about.
  const definitionRows = await repo.db.getAll<{name: string | null; n: number}>(
    `SELECT json_extract(b.properties_json, ?) AS name, COUNT(*) AS n
       FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = ? AND b.workspace_id = ? AND b.deleted = 0
      GROUP BY name`,
    [`$."${propertyNameProp.name}"`, PROPERTY_SCHEMA_TYPE, workspaceId],
  )
  const definitionBlocksByName = new Map<string, number>()
  for (const row of definitionRows) {
    if (typeof row.name === 'string') definitionBlocksByName.set(row.name, row.n)
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

  await attachProvenance(repo, workspaceId, unregistered, {
    keys: limits.keys ?? PROVENANCE_KEY_LIMIT,
    blocksPerKey: limits.blocksPerKey ?? PROVENANCE_BLOCKS_PER_KEY,
  })

  return {
    workspaceId,
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
         SELECT j.key AS property,
                b.id AS blockId,
                ROW_NUMBER() OVER (PARTITION BY j.key ORDER BY b.id) AS rn
           FROM blocks b, json_each(${OBJECT_BAG}) j
          WHERE b.workspace_id = ? AND b.deleted = 0
            AND j.key IN (SELECT value FROM json_each(?))
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
