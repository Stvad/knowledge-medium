/**
 * Data-model grain checks against real values.
 *
 * The source lint (`extensionLint.ts`) reads declarations and can only
 * guess: it cannot tell a block id from an external id, or a JSON config
 * object from a list of records. These checks look at the values instead,
 * so they answer the same questions with evidence — is this string an id
 * that resolves to a live block? does this JSON cell hold records?
 *
 * Two entry points, one rule set:
 *   - `writeWarnings` runs on the properties a bridge write is about to
 *     store, so a mistake surfaces at the moment it's made (and catches
 *     the silent case where the owning extension isn't running, so the
 *     write lands raw with no codec and no reference projection).
 *   - `auditBlocks` runs over blocks that already exist, which is where
 *     drift shows up: values written by an older version, by hand, or by
 *     a script.
 */

import type { AnyPropertySchema, BlockData } from '@/data/api'
import { isRefCodec, isRefListCodec } from '@/data/api'
import type { Repo } from '@/data/repo'

export interface GrainWarning {
  /** Stable id: `unknown-property` | `block-id-not-a-ref` | `records-in-json-value`. */
  rule: string
  /** The property this is about. */
  property: string
  message: string
  /** Block the value sits on. Absent for a pre-write check. */
  blockId?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Properties every block may legitimately carry with no extension schema
 *  behind them — kernel-owned bookkeeping, and the app's own namespaced
 *  UI state. Warning about these would drown the real signal. */
const isSystemProperty = (name: string): boolean =>
  name === 'types' || name === 'alias' || name.startsWith('system:') || name.startsWith('agent:')

const isRefSchema = (schema: AnyPropertySchema | undefined): boolean =>
  schema !== undefined && (isRefCodec(schema.codec) || isRefListCodec(schema.codec))

const schemasOf = (repo: Repo): ReadonlyMap<string, AnyPropertySchema> =>
  repo.snapshotTypeRegistries().propertySchemas

/** Does this value read as a list of records (objects), rather than a
 *  scalar list or an opaque config object? */
const holdsRecords = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry))

/** Id-shaped strings in a value: the string itself, or the entries of a
 *  string array (a hand-rolled list of ids that wants to be a `refList`). */
const idCandidates = (value: unknown): string[] => {
  if (typeof value === 'string') return UUID_RE.test(value) ? [value] : []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
  return []
}

const unknownPropertyMessage = (name: string): string =>
  `No registered schema for \`${name}\` — the value is stored raw: no codec (so it never decodes to a typed value), and if it holds a block id it will NOT project into references. Usually this means the owning extension isn't running on this device (install → enable → reload), or the name is a typo of a declared property.`

const blockIdMessage = (name: string, targetId: string): string =>
  `\`${name}\` holds ${targetId}, which is a live block, but its schema is not ref-typed — so the target's backlinks will never show this block, and the link won't survive a merge or retarget. Declare the property with the \`ref\` / \`optional-ref\` / \`refList\` preset and \`config: {targetTypes: [...]}\`.`

const recordsMessage = (name: string, count: number): string =>
  `\`${name}\` holds ${count} records in one cell. Nothing can query, reference, or undo an individual one, and a concurrent write replaces the whole list. Make each record a child block (see the \`record-grain\` guide).`

/** Warnings for a property bag about to be written. `resolvesToBlock` is
 *  injected so callers can batch the lookup; it answers "is this id a live
 *  block in this workspace". */
export const grainWarningsForProperties = async (
  repo: Repo,
  properties: Readonly<Record<string, unknown>>,
  resolvesToBlock: (id: string) => Promise<boolean>,
  blockId?: string,
): Promise<GrainWarning[]> => {
  const schemas = schemasOf(repo)
  const warnings: GrainWarning[] = []
  const at = (rule: string, property: string, message: string): GrainWarning =>
    blockId === undefined ? {rule, property, message} : {rule, property, message, blockId}

  for (const [name, value] of Object.entries(properties)) {
    if (isSystemProperty(name)) continue
    const schema = schemas.get(name)

    if (!schema) {
      warnings.push(at('unknown-property', name, unknownPropertyMessage(name)))
      // Everything below reasons about the schema's shape; with none
      // registered, the unknown-property warning already says the most
      // useful thing.
      continue
    }

    if (holdsRecords(value)) {
      warnings.push(at('records-in-json-value', name, recordsMessage(name, (value as unknown[]).length)))
    }

    if (!isRefSchema(schema)) {
      for (const candidate of idCandidates(value)) {
        if (await resolvesToBlock(candidate)) {
          warnings.push(at('block-id-not-a-ref', name, blockIdMessage(name, candidate)))
          break
        }
      }
    }
  }

  return warnings
}

/** Live-block lookup backed by the repo's SQL, memoized per call site so a
 *  batch of blocks pointing at the same target costs one query. */
export const createBlockResolver = (repo: Repo): ((id: string) => Promise<boolean>) => {
  const cache = new Map<string, Promise<boolean>>()
  return (id: string) => {
    const hit = cache.get(id)
    if (hit) return hit
    const lookup = repo.db
      .getOptional<{id: string}>('SELECT id FROM blocks WHERE id = ? AND deleted = 0', [id])
      .then(row => row !== null && row !== undefined)
      .catch(() => false)
    cache.set(id, lookup)
    return lookup
  }
}

/** Warnings for one bridge write. Kept small and best-effort: a write is
 *  never blocked by this, and a failure to check must not fail the write. */
export const writeWarnings = async (
  repo: Repo,
  properties: Readonly<Record<string, unknown>> | undefined,
): Promise<GrainWarning[]> => {
  if (!properties || Object.keys(properties).length === 0) return []
  try {
    return await grainWarningsForProperties(repo, properties, createBlockResolver(repo))
  } catch {
    return []
  }
}

/** Audit blocks that already exist. Same rules, applied to stored values. */
export const auditBlocks = async (
  repo: Repo,
  blocks: readonly BlockData[],
): Promise<GrainWarning[]> => {
  const resolves = createBlockResolver(repo)
  const warnings: GrainWarning[] = []
  for (const block of blocks) {
    warnings.push(...await grainWarningsForProperties(repo, block.properties, resolves, block.id))
  }
  return warnings
}

/** How many blocks one audit reads. An audit is an explicit, interactive
 *  command, but a type with 100k rows shouldn't stall the bridge — and the
 *  first few hundred blocks of a type are enough to characterise it. The
 *  result says when this bit, so a partial scan never reads as "all clear". */
export const AUDIT_BLOCK_LIMIT = 400

export interface TypeAuditSummary {
  type: string
  blocks: number
  /** Scanned fewer than `blocks` because the limit bit. */
  truncated: boolean
}

export interface GrainAuditResult {
  types: TypeAuditSummary[]
  blocksScanned: number
  warnings: GrainWarning[]
  /** Types the extension declares that no block carries — usually a type
   *  that was renamed, or one whose write path was never finished. */
  unusedTypes: string[]
}

/** Audit every block carrying one of `typeIds`.
 *
 *  Scanning BY TYPE (rather than by property name) is deliberate: it finds
 *  the blocks the extension actually created, including properties it wrote
 *  under names it never declared — which is the interesting case, since that
 *  is what a write made while the extension wasn't running looks like. */
export const auditExtensionData = async (
  repo: Repo,
  workspaceId: string,
  typeIds: readonly string[],
  limit: number = AUDIT_BLOCK_LIMIT,
): Promise<GrainAuditResult> => {
  const types: TypeAuditSummary[] = []
  const unusedTypes: string[] = []
  const seen = new Set<string>()
  const blocks: BlockData[] = []

  for (const type of typeIds) {
    const counted = await repo.db.get<{n: number}>(
      `SELECT COUNT(*) AS n FROM block_types t JOIN blocks b ON b.id = t.block_id
       WHERE t.type = ? AND t.workspace_id = ? AND b.deleted = 0`,
      [type, workspaceId],
    )
    const total = counted?.n ?? 0
    if (total === 0) {
      unusedTypes.push(type)
      continue
    }
    const rows = await repo.db.getAll<{id: string}>(
      `SELECT b.id FROM block_types t JOIN blocks b ON b.id = t.block_id
       WHERE t.type = ? AND t.workspace_id = ? AND b.deleted = 0
       ORDER BY b.updated_at DESC LIMIT ?`,
      [type, workspaceId, limit],
    )
    types.push({type, blocks: total, truncated: total > rows.length})
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      const block = await repo.load(row.id)
      if (block && !block.deleted) blocks.push(block)
    }
  }

  return {
    types,
    blocksScanned: blocks.length,
    warnings: await auditBlocks(repo, blocks),
    unusedTypes,
  }
}
