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
 * The scan itself — every key, its cell count, and whether the registry
 * resolves it — is `scanPropertyKeys` (`@/data/internals/propertyKeyScan`),
 * shared with §9's orphan-definition synthesis so the report and the writer
 * can never disagree about which keys are orphaned. This file adds the two
 * things only an operator report needs: the prose fix per key, and a sampled
 * provenance pass. The sibling `grainAudit` caps its scan
 * (`AUDIT_BLOCK_LIMIT`) because sampling a type characterises it; the shared
 * scan deliberately does not, because a partial coverage list reading as
 * "all clear" is worse than no list. Only the provenance pass is sampled,
 * and it says so.
 */

import type { PropertySchemaIdentityUnavailableReason } from '@/data/api'
import { keyCannotBeDefined } from '@/data/internals/propertyDefinitionSynthesis'
import {
  OBJECT_BAG, keyOf, scanPropertyKeys,
  type PropertyKeyScan, type UnresolvedPropertyKey,
} from '@/data/internals/propertyKeyScan'
import type { Repo } from '@/data/repo'

export interface UnregisteredPropertyTypeUsage {
  /** A type carried by blocks holding this key. */
  type: string
  /** Sampled blocks with this type — NOT the workspace-wide total. Bounded
   *  by the provenance sample (see `PROVENANCE_BLOCKS_PER_KEY`); `cells` is
   *  the exact count. */
  sampledBlocks: number
}

export interface UnregisteredProperty extends UnresolvedPropertyKey {
  /** What to do about it, in the order §9 requires. */
  fix: string
  /** Set when no definition can ever back the key, so the flip must not
   *  proceed until it is remapped or deleted. The same verdict the migration
   *  command refuses on (`keyCannotBeDefined`). */
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
export interface PropertyRegistrationAudit
  extends Omit<PropertyKeyScan, 'unresolved'> {
  /** When this device last completed a sync, or null if it never has (or there
   *  is no sync layer). The rest of the report's basis, and the part no check
   *  can establish: `syncGap` being null says nothing is outstanding LOCALLY,
   *  never that the server has nothing this device has not been told about.
   *  Record it beside the counts rather than judging it — it does not advance
   *  on a connected idle graph, so a current device on a quiet graph and a
   *  stale one look identical here. */
  syncedThrough: string | null
  unregistered: UnregisteredProperty[]
  unregisteredCells: number
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

const undeclaredFix =
  'Nothing declares this name — no definition block, no code seed — so property ' +
  'migration skips it (propertyChildrenProcessor.ts: `resolveNameSchema` → `continue`) ' +
  'and it is the one class of property data a flipped workspace cannot make ' +
  'child-backed. Fix IN THIS ORDER: (1) if an extension owns the key, install / ' +
  'enable it so its seed materializes the definition; (2) only then run "Migrate ' +
  'properties to child blocks" from the palette, whose §9 orphan synthesis mints a ' +
  'hidden user-origin definition with a preset inferred from the stored values. ' +
  'Synthesizing first and enabling the owner later collides in the winner machinery ' +
  "and strands field rows on the loser's fieldId. Registering is additive — no cell " +
  'value is rewritten.'

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

/** A key `keyCannotBeDefined` rejects. Its own reason carries the WHY; this
 *  adds the consequence, which is the same for every such key. */
const hopelessKeyFix = (reason: string): string =>
  `Hard flip blocker — ${reason}. Since no definition can back it, "every cell key ` +
  'resolves a definition" can never hold while it exists: the migration command refuses ' +
  'to switch this workspace over until it is deleted or its value is remapped under a ' +
  'named key (§9).'

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
  // The same predicate synthesis and the flip gate use, so this report cannot
  // call a key fixable that the migration will refuse to proceed past.
  const hopeless = keyCannotBeDefined(entry.property)
  if (hopeless !== null) return {fix: hopelessKeyFix(hopeless), blocksFlip: true}
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

/** The shared scan (`scanPropertyKeys`) plus the two operator-report layers:
 *  a prose fix per unresolved key, and sampled provenance for the top ones. */
export const auditPropertyRegistration = async (
  repo: Repo,
  workspaceId: string,
  limits: {keys?: number; blocksPerKey?: number} = {},
): Promise<PropertyRegistrationAudit> => {
  const scan = await scanPropertyKeys(repo, workspaceId)

  const unregistered: UnregisteredProperty[] = scan.unresolved.map(entry => ({
    ...entry,
    ...describeUnregisteredProperty(entry),
    types: [],
    sampleBlockIds: [],
  }))

  // Clamp rather than trust. `rn` starts at 1, so `blocksPerKey: 0` would
  // filter EVERY provenance row while leaving `provenanceOmitted` unset —
  // every in-cap key would read as "sampled, genuinely no types" when in
  // fact nothing was sampled. A negative `keys` is worse than useless too:
  // `slice(0, -1)` keeps all-but-the-last rather than meaning "none".
  await attachProvenance(repo, workspaceId, unregistered, {
    keys: Math.max(0, Math.floor(limits.keys ?? PROVENANCE_KEY_LIMIT)),
    blocksPerKey: Math.max(1, Math.floor(limits.blocksPerKey ?? PROVENANCE_BLOCKS_PER_KEY)),
  })

  // Spelled out rather than spread: `unresolved` is the one field this report
  // replaces, and listing the rest means a new field on the scan surfaces as a
  // compile error here — a decision about whether the report wants it — instead
  // of appearing in the output unannounced.
  return {
    workspaceId: scan.workspaceId,
    syncGap: scan.syncGap,
    distinctProperties: scan.distinctProperties,
    propertyCells: scan.propertyCells,
    registeredProperties: scan.registeredProperties,
    unreadableBlocks: scan.unreadableBlocks,
    syncedThrough: repo.lastSyncedAt?.toISOString() ?? null,
    unregistered,
    unregisteredCells: unregistered.reduce((sum, entry) => sum + entry.cells, 0),
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
