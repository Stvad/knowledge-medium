/**
 * The consistency audit's property-children checks — the READ-ONLY half of
 * the post-switch consistency sweep (#1011). On a workspace at
 * `properties_migration = 'children'` the cell is still dual-written and is the
 * read surface, while the field rows and their value children are the truth
 * that crosses sync; these checks say how far the two have drifted.
 *
 * None of them repairs anything. A repair rewrites rows and so is a gated data
 * step of its own, never a side effect of an audit.
 *
 * Each check answers one question through the code that owns it, so the audit
 * cannot disagree with the writer: coverage is `surveyPropertyCellCoverage`
 * (also behind `audit-properties`), and divergence recomputes cells through
 * `projectFieldRowValues`, the PROJECT processor's own projection.
 */
import type { ResolvedPropertySchema } from '@/data/api'
import type { Repo } from '@/data/repo'
import { requirePropertyRegistryFor } from '@/data/internals/propertyKeyScan'
import {
  SCAN_PAGE,
  surveyPropertyCellCoverage,
  type PropertyCellCoverageBucket,
} from '@/data/internals/propertyCellBackfill'
import { projectFieldRowValues } from '@/data/internals/propertyChildrenProcessor'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'
import { buildInClause, MAX_IDS_PER_IN_CLAUSE } from '@/data/internals/sqlBinds'
import { propertyFieldRowsForParentsSql } from '@/data/internals/treeQueries'
import { chunk as chunksOf } from 'lodash-es'
import type { AuditDb, ConsistencyCheckResult } from './audit.js'
import { parsePropertiesJson } from './rowJson.js'

/** Owners named per divergent key — a way in, not the work list. */
const OWNERS_PER_KEY = 3

/** Wait for the audited workspace's registry to produce its first complete
 *  snapshot: until then every key reads as unresolved and drops out of every
 *  count, which is an all-clear. Only the open workspace has a registry to wait
 *  for, and its registry reads as not loaded until that snapshot lands, so the
 *  guard is asked before the wait only for another workspace (where the wait
 *  would refuse with a message that names no fix) and after it always. */
const readyRegistry = async (repo: Repo, workspaceId: string): Promise<void> => {
  if (workspaceId !== repo.activeWorkspaceId) requirePropertyRegistryFor(repo, workspaceId)
  await repo.whenPropertyDefinitionsReady(workspaceId)
  // Defence in depth: only two workspace switches during the wait reach it.
  requirePropertyRegistryFor(repo, workspaceId)
}

const DUPLICATE_PAIRS_FROM = `
  FROM blocks INDEXED BY idx_blocks_any_field_form
  WHERE workspace_id = ? AND is_field_form = 1 AND deleted = 0
    AND reference_target_id IS NOT NULL
  GROUP BY parent_id, reference_target_id
  HAVING count(*) > 1`

/** More than one live field row for one (owner, definition). Two devices each
 *  minting the first field row for a property leave this, and the fold
 *  (`collapseDuplicateFieldRow`) runs only on a later local write to the owner,
 *  so a pair can sit indefinitely. Samples are the OWNERS, where the fold runs. */
export const runPropertyFieldRowDuplicatesCheck = async (
  db: AuditDb, workspaceId: string, sampleLimit: number,
): Promise<ConsistencyCheckResult> => {
  const [totals] = await db.getAll<{ pairs: number; extra: number | null }>(
    `SELECT count(*) AS pairs, sum(n - 1) AS extra
       FROM (SELECT count(*) AS n ${DUPLICATE_PAIRS_FROM})`,
    [workspaceId],
  )
  const duplicatePairs = Number(totals?.pairs ?? 0)
  const samples = duplicatePairs === 0 ? [] : (await db.getAll<{ id: string }>(
    `SELECT DISTINCT parent_id AS id FROM (SELECT parent_id ${DUPLICATE_PAIRS_FROM}) LIMIT ${sampleLimit}`,
    [workspaceId],
  )).map(row => String(row.id))
  return {
    status: duplicatePairs > 0 ? 'anomaly' : 'ok',
    duplicatePairs,
    /** Rows the fold would merge away: each pair's rows beyond the first. */
    extraFieldRows: Number(totals?.extra ?? 0),
    samples,
  }
}

const bucketOwners = (bucket: PropertyCellCoverageBucket): string[] =>
  bucket.keys.flatMap(key => key.blockIds)

/** Registered cells with no live field row — `missing` (what a re-run of the
 *  properties migration writes), `refused` (the codec rejects the value) and
 *  `deletedThroughChildren` (the only field row is tombstoned). Every bucket is
 *  a cell the children do not back, so any of them is an anomaly. */
export const runPropertyCellCoverageCheck = async (
  repo: Repo, workspaceId: string, sampleLimit: number,
  betweenPages?: () => Promise<void>,
): Promise<ConsistencyCheckResult> => {
  await readyRegistry(repo, workspaceId)
  const coverage = await surveyPropertyCellCoverage(repo, workspaceId, betweenPages)
  const uncovered = coverage.missing.cells + coverage.refused.cells
    + coverage.deletedThroughChildren.cells
  const samples = [...new Set([
    ...bucketOwners(coverage.missing),
    ...bucketOwners(coverage.refused),
    ...bucketOwners(coverage.deletedThroughChildren),
  ])].slice(0, sampleLimit)
  return { status: uncovered > 0 ? 'anomaly' : 'ok', uncoveredCells: uncovered, ...coverage, samples }
}

/** How a cell key differs from what its field rows project. */
type DivergenceKind =
  /** The field rows project a value; the cell lacks the key. */
  | 'cellMissing'
  /** The cell holds the key; its live field rows project nothing. */
  | 'cellExtra'
  /** Both hold a value, and they differ. */
  | 'cellDiffers'

const divergenceOf = (stored: unknown, projected: unknown): DivergenceKind | null => {
  if (stored === undefined) return projected === undefined ? null : 'cellMissing'
  if (projected === undefined) return 'cellExtra'
  return jsonValuesEqual(stored, projected) ? null : 'cellDiffers'
}

const OWNERS_WITH_FIELD_ROWS_SQL = `
  SELECT DISTINCT parent_id AS id FROM blocks INDEXED BY idx_blocks_any_field_form
   WHERE workspace_id = ? AND is_field_form = 1 AND deleted = 0
     AND reference_target_id IS NOT NULL AND parent_id > ?
   ORDER BY parent_id
   LIMIT ?`

/** The value set the processor reads (`fieldValueChildren`): live, unmarked
 *  direct children, in `(order_key, id)` order. The ORDER BY is the contract
 *  even though no test can see it go: the parent index returns this order. */
const valueChildrenSql = (count: number): string => `
  SELECT id, parent_id AS parentId, content FROM blocks
   WHERE parent_id IN (${buildInClause(count)}) AND deleted = 0 AND is_field_form IS NOT 1
   ORDER BY order_key, id`

interface FieldRowRow { id: string; parentId: string; fieldId: string; deleted: number }
interface ValueRow { id: string; parentId: string; content: string }

const inChunks = async <T>(
  ids: readonly string[],
  read: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> => {
  const out: T[] = []
  for (const chunk of chunksOf(ids, MAX_IDS_PER_IN_CLAUSE)) out.push(...await read(chunk))
  return out
}

/** Recompute every child-backed cell key from its live field rows' value
 *  children and compare with the stored cell. Owners are visited in keyset
 *  pages, so memory is bounded by a page, not by the graph.
 *
 *  Cell keys with no live field row are coverage's question, not this one's:
 *  only (owner, definition) pairs with a field row are recomputed. A field row
 *  whose definition does not resolve to a winner projects nothing in the
 *  processor either, so it is counted (`unresolvedFields`) and not compared. */
export const runPropertyCellDivergenceCheck = async (
  db: AuditDb, repo: Repo, workspaceId: string, sampleLimit: number,
): Promise<ConsistencyCheckResult> => {
  await readyRegistry(repo, workspaceId)
  const resolver = repo.propertySchemaResolverFor(workspaceId)
  const schemaOf = new Map<string, ResolvedPropertySchema<unknown> | null>()
  const resolveField = (fieldId: string): ResolvedPropertySchema<unknown> | null => {
    let schema = schemaOf.get(fieldId)
    if (schema === undefined) {
      const resolution = resolver.resolveField(fieldId)
      schema = resolution.status === 'resolved' ? resolution.schema : null
      schemaOf.set(fieldId, schema)
    }
    return schema
  }

  let ownersScanned = 0
  let fieldsChecked = 0
  let unresolvedFields = 0
  let divergentCells = 0
  let divergentBlocks = 0
  const byKind: Record<DivergenceKind, number> = { cellMissing: 0, cellExtra: 0, cellDiffers: 0 }
  const keys = new Map<string, { key: string; cells: number; blockIds: string[] }>()
  const samples: string[] = []

  let cursor = ''
  for (;;) {
    const page = (await db.getAll<{ id: string }>(
      OWNERS_WITH_FIELD_ROWS_SQL, [workspaceId, cursor, SCAN_PAGE])).map(row => String(row.id))
    if (page.length === 0) break
    cursor = page[page.length - 1]!

    const owners = await inChunks(page, chunk => db.getAll<{ id: string; propertiesJson: string }>(
      `SELECT id, properties_json AS propertiesJson FROM blocks
        WHERE id IN (${buildInClause(chunk.length)}) AND deleted = 0`, chunk))
    const fieldRows = (await inChunks(page, chunk => db.getAll<FieldRowRow>(
      propertyFieldRowsForParentsSql(
        'id, parent_id AS parentId, reference_target_id AS fieldId, deleted', chunk.length),
      [workspaceId, ...chunk]))).filter(row => Number(row.deleted) === 0)
    const values = await inChunks(fieldRows.map(row => row.id),
      chunk => db.getAll<ValueRow>(valueChildrenSql(chunk.length), chunk))

    const valuesOf = new Map<string, ValueRow[]>()
    for (const value of values) {
      const list = valuesOf.get(value.parentId)
      if (list) list.push(value)
      else valuesOf.set(value.parentId, [value])
    }
    /** owner → fieldId → its field rows, each still in `(order_key, id)` order. */
    const fieldsOf = new Map<string, Map<string, FieldRowRow[]>>()
    for (const row of fieldRows) {
      let fields = fieldsOf.get(row.parentId)
      if (fields === undefined) fieldsOf.set(row.parentId, fields = new Map())
      const rows = fields.get(row.fieldId)
      if (rows) rows.push(row)
      else fields.set(row.fieldId, [row])
    }

    for (const owner of owners) {
      ownersScanned += 1
      const cell = parsePropertiesJson(owner.propertiesJson)
      let ownerDiverges = false
      for (const [fieldId, rows] of fieldsOf.get(owner.id) ?? []) {
        const schema = resolveField(fieldId)
        if (schema === null) {
          unresolvedFields += 1
          continue
        }
        fieldsChecked += 1
        const projected = projectFieldRowValues(schema, rows.map(row => valuesOf.get(row.id) ?? []))
        const stored = Object.hasOwn(cell, schema.name) ? cell[schema.name] : undefined
        const kind = divergenceOf(stored, projected)
        if (kind === null) continue
        divergentCells += 1
        byKind[kind] += 1
        ownerDiverges = true
        let entry = keys.get(schema.name)
        if (entry === undefined) keys.set(schema.name, entry = { key: schema.name, cells: 0, blockIds: [] })
        entry.cells += 1
        if (entry.blockIds.length < OWNERS_PER_KEY) entry.blockIds.push(owner.id)
      }
      if (ownerDiverges) {
        divergentBlocks += 1
        if (samples.length < sampleLimit) samples.push(owner.id)
      }
    }
    if (page.length < SCAN_PAGE) break
  }

  return {
    status: divergentCells > 0 ? 'anomaly' : 'ok',
    ownersScanned,
    fieldsChecked,
    unresolvedFields,
    divergentCells,
    divergentBlocks,
    byKind,
    keys: [...keys.values()],
    samples,
  }
}
