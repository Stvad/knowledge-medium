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
 */

import type { PropertySchemaIdentityUnavailableReason } from '@/data/api'
import type { Repo } from '@/data/repo'

export interface UnregisteredPropertyTypeUsage {
  /** A type carried by blocks holding this key. */
  type: string
  blocks: number
}

export interface UnregisteredProperty {
  property: string
  /** Live blocks in this workspace carrying the key. */
  cells: number
  /** The resolver's own verdict, so this report and the migration cannot
   *  disagree about what is registered. */
  reason: PropertySchemaIdentityUnavailableReason
  /** Definition blocks the workspace holds for this name. Non-zero with an
   *  unresolved name means a broken or shadowed definition, not a missing
   *  one — a different fix. */
  definitionBlocks: number
  /** What to do about it, in the order §9 requires. */
  fix: string
  /** Set when no definition can ever back the key, so the flip must not
   *  proceed until it is remapped or deleted. */
  blocksFlip?: true
  /** Types carried by the blocks holding the key — the machine-readable
   *  hint about which extension wrote it. Blocks with no type contribute
   *  nothing here. */
  types: UnregisteredPropertyTypeUsage[]
  sampleBlockIds: string[]
  /** The provenance scan didn't reach this key (see the limits below); its
   *  `cells` count is still exact. */
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
  /** Live blocks whose `properties_json` doesn't parse — e2ee ciphertext
   *  envelopes, or corruption. Their keys are invisible to this audit, so a
   *  non-zero count means the report is incomplete rather than clean. */
  unreadableBlocks: number
}

/** Keys we read provenance (types + samples) for, highest cell count first.
 *  The classification and counts cover every key regardless; this only
 *  bounds the second pass, which touches individual blocks. */
export const PROVENANCE_KEY_LIMIT = 50
/** Rows the provenance pass reads. A key with 200k cells doesn't need 200k
 *  rows to be characterised, and the bridge shouldn't stall on one. */
export const PROVENANCE_ROW_LIMIT = 5000
/** Sample block ids kept per key — enough to open one and see the shape. */
const SAMPLES_PER_KEY = 3

/** `json_each` raises on malformed JSON, and it is not safe to rely on a
 *  `WHERE json_valid(...)` term being evaluated first. Guarding inside the
 *  argument makes the skip evaluation-order independent, which matters
 *  because an e2ee workspace's cells are ciphertext, not JSON. */
const CELLS_JSON = `json_each(CASE WHEN json_valid(b.properties_json) THEN b.properties_json ELSE '{}' END)`

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
  'from it (unknown preset, or config the codec rejects), so it registers no schema ' +
  'and the name resolves to nothing. Repair that definition block — adding a second ' +
  'one for the same name would collide.'

const shadowedFix =
  'A definition block exists for this name but is not the winner the workspace ' +
  'selects, so the name resolves to nothing. Resolve the shadowing (retire the ' +
  'loser, or rename it) rather than adding another definition.'

const ambiguousFix =
  'Two or more code seeds declare this same name, so the registry drops the ' +
  'colliders and the name resolves to nothing. Namespace one of them ' +
  '(`myplugin:name`) — until then the colliding declarations share one stored cell.'

const emptyKeyFix =
  'The empty property key is a hard flip blocker: no definition can ever back it. ' +
  'Delete or remap it before any workspace flips to child-backed properties (§9).'

/** Reason → what to do. Pure, so every branch is reachable in a test without
 *  having to manufacture a broken registry. */
export const describeUnregisteredProperty = (
  entry: {
    property: string
    reason: PropertySchemaIdentityUnavailableReason
    definitionBlocks: number
  },
): {fix: string; blocksFlip?: true} => {
  if (entry.property === '') return {fix: emptyKeyFix, blocksFlip: true}
  if (entry.reason === 'ambiguous') return {fix: ambiguousFix}
  if (entry.reason === 'shadowed') return {fix: shadowedFix}
  // 'registry-not-workspace-keyed' means the resolver had no workspace
  // registry at all, which the caller has already ruled out by resolving a
  // workspace id; treat it like any other unbuildable definition.
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

/** Enumerate every property key in the workspace's live blocks and classify
 *  each against the same resolver the migration uses. */
export const auditPropertyRegistration = async (
  repo: Repo,
  workspaceId: string,
): Promise<PropertyRegistrationAudit> => {
  // `propertySchemaResolverFor` fails CLOSED for a workspace that is neither
  // active nor immediately-previous — every name resolves to
  // identity-unavailable. Auditing through that resolver would report the
  // whole graph as unregistered: a false list that reads authoritative and
  // could talk someone into synthesizing definitions for keys that already
  // have them. Refuse instead, and say what to do.
  const registry = repo.propertyDefinitions
  if (!registry || registry.workspaceId !== workspaceId) {
    throw new Error(
      `Cannot audit ${workspaceId}: its property-definition registry is not loaded ` +
      `(loaded: ${registry?.workspaceId ?? 'none'}). Classification would read every key ` +
      'as unregistered. Open that workspace in the app and re-run.',
    )
  }

  const histogram = await repo.db.getAll<HistogramRow>(
    `SELECT j.key AS property, COUNT(*) AS cells
       FROM blocks b, ${CELLS_JSON} j
      WHERE b.workspace_id = ? AND b.deleted = 0
      GROUP BY j.key`,
    [workspaceId],
  )

  const unreadable = await repo.db.get<{n: number}>(
    `SELECT COUNT(*) AS n FROM blocks
      WHERE workspace_id = ? AND deleted = 0 AND NOT json_valid(properties_json)`,
    [workspaceId],
  )

  const resolver = repo.propertySchemaResolverFor(workspaceId)
  const definitionsByName = registry.definitionsByName

  const unregistered: UnregisteredProperty[] = []
  let registeredProperties = 0
  let propertyCells = 0

  for (const row of histogram) {
    // SQLite gives an integer key for a JSON array; a property bag is always
    // an object, so this is defensive rather than expected.
    const property = typeof row.property === 'string' ? row.property : String(row.property ?? '')
    propertyCells += row.cells

    const resolution = resolver.resolve(property)
    if (resolution.status === 'resolved') {
      registeredProperties += 1
      continue
    }

    const definitionBlocks = definitionsByName.get(property)?.length ?? 0
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

  await attachProvenance(repo, workspaceId, unregistered)

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

/** Second pass: for the top keys, which blocks carry them and what types do
 *  those blocks have. Mutates `unregistered` in place — the counts from the
 *  first pass stay authoritative, so a truncated provenance read degrades
 *  detail without ever making the report look cleaner than it is. */
const attachProvenance = async (
  repo: Repo,
  workspaceId: string,
  unregistered: UnregisteredProperty[],
): Promise<void> => {
  const targeted = unregistered.slice(0, PROVENANCE_KEY_LIMIT)
  for (const entry of unregistered.slice(PROVENANCE_KEY_LIMIT)) entry.provenanceOmitted = true
  if (targeted.length === 0) return

  const rows = await repo.db.getAll<ProvenanceRow>(
    `SELECT j.key AS property,
            b.id AS blockId,
            (SELECT json_group_array(bt.type) FROM block_types bt
              WHERE bt.block_id = b.id AND bt.workspace_id = b.workspace_id) AS types
       FROM blocks b, ${CELLS_JSON} j
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND j.key IN (SELECT value FROM json_each(?))
      ORDER BY j.key, b.id
      LIMIT ?`,
    [workspaceId, JSON.stringify(targeted.map(entry => entry.property)), PROVENANCE_ROW_LIMIT],
  )

  const typeCounts = new Map<string, Map<string, number>>()
  const samples = new Map<string, string[]>()
  for (const row of rows) {
    const property = typeof row.property === 'string' ? row.property : String(row.property ?? '')
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
      .map(([type, blocks]) => ({type, blocks}))
      .sort((left, right) => right.blocks - left.blocks || left.type.localeCompare(right.type))
    // The row cap bit before this key's rows were read. Its count is exact;
    // only the provenance is missing, and saying so beats an empty list that
    // reads as "no types".
    if (entry.sampleBlockIds.length === 0) entry.provenanceOmitted = true
  }
}
