/**
 * The one way a metrics record reaches the graph.
 *
 * Both recorders share one write path — a per-client group under a hidden
 * ui-state subtree — so the guards for that shape live here once: eligibility
 * re-taken in the transaction, `skipMetadata`, the type tag in the same
 * transaction as the create. A stronger rule passes via `assertEligible`;
 * retention stays the interaction recorder's own.
 *
 * THE ORDERING RULE: the eligibility check is the last statement before the
 * write it authorises, no `await` between — everything earlier is
 * provisional (a throw anywhere rolls the transaction back). This
 * guarantees authorised-when-ISSUED, not at commit. ACCEPTED: a sample can
 * be one transaction stale.
 */
import { ChangeScope, type BlockData, type PropertySchema, type TypeContribution } from '@/data/api'
import { typesProp } from '@/data/properties.js'
import type { Repo } from '@/data/repo'
import {
  getPluginUIStateBlock,
  getPluginUIStateChild,
  pluginUIStateBlockId,
  stateChildBlockId,
} from '@/data/stateBlocks.js'
import { jsonPathForProperty, type PropertyName } from '@/data/internals/typedBlockQuery.js'
import { keyAtStart } from '@/data/orderKey.js'
import { deviceSurface, getClientId } from '@/utils/clientId.js'
import { v4 as uuidv4 } from 'uuid'
import { deleteSubtreeInTx } from '@/data/subtreeDelete.js'
import { assertStillWritable, NoLongerEligible } from './sessionContext.js'

/** The property write that IS the record; `skipMetadata` keeps
 *  `user_updated_at` unstamped — DEFENCE IN DEPTH given `content: ''`. */
export interface RecordWrite {
  property: PropertySchema<unknown>
  data: unknown
}

/** Apply a record write. The ONE place `skipMetadata` is decided. */
const writeRecord = async (
  tx: Parameters<Parameters<Repo['tx']>[0]>[0],
  blockId: string,
  record: RecordWrite,
): Promise<void> => {
  await tx.setProperty(blockId, record.property, record.data, { skipMetadata: true })
}

export interface ClientRecordSpec {
  workspaceId: string
  containerType: TypeContribution
  /** Applied to the record row so it's queryable/auditable, not inferred from tree position. */
  recordType: TypeContribution
  description: string
  /** Called TWICE — before the group ensure (refuse before the expensive
   *  step) and again under THE ORDERING RULE as the last statement before
   *  the write. Defaults to `assertStillWritable`; a stronger rule must pass its own. */
  assertEligible?: (repo: Repo, workspaceId: string) => void
  /** Required — a recorder cannot reach the graph without stating a bound. */
  retain: number
  /** See `clientSeriesQuery`'s `orderField` — must rank by the same field the reader calls newest. */
  orderField?: string
  /** Record-property NAME, not JSON path — retention needs both forms, and
   *  only considers rows CARRYING one (a group may hold a hand-created child). */
  recordName: PropertyName
  record: RecordWrite
  /** Called as soon as the record is DURABLE, before retention runs —
   *  publishing ownership later would let the reader double-count the live session. */
  onCommitted?: (blockId: string) => void
}

/** This client's group id, DERIVED — no read, no create. The reader matches
 *  on exactly this parent, so anything agreeing with it must use this id. */
export const clientGroupId = (
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): string =>
  stateChildBlockId(
    pluginUIStateBlockId(workspaceId, repo.user.id, containerType.id),
    getClientId(),
  )

/** This client's group under `containerType`, creating it if absent. Not
 *  flagged `telemetry` — ACCEPTED, two transactions on first append only;
 *  threading a flag through would be worse (helpers are MEMOIZED without it). */
const ensureClientGroup = async (
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): Promise<string> => {
  const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, containerType)
  const clientId = getClientId()
  // EXPLICITLY empty: a missing title defaults to the client UUID, which
  // would leak into FTS-based block discovery. ACCEPTED: existing groups
  // keep their old title rather than being migrated.
  const group = await getPluginUIStateChild(root, clientId, '')
  return group.id
}

/** Append one record and return its block id. Create, type tag and property
 *  land in ONE transaction — split across two, a failure between them
 *  leaves a durable typed child with no record on it. */
export const appendClientRecord = async (
  repo: Repo,
  spec: ClientRecordSpec,
): Promise<{ blockId: string; groupId: string }> => {
  const assertEligible = spec.assertEligible ?? assertStillWritable
  // BEFORE the ensure, which MINTS blocks — refuses before the expensive
  // step, though it can't close the window (ensure opens its own
  // transactions). ACCEPTED: the alternatives duplicate core or leak this
  // rule into shared machinery.
  assertEligible(repo, spec.workspaceId)
  const groupId = await ensureClientGroup(repo, spec.workspaceId, spec.containerType)
  const blockId = uuidv4()
  // Newest-first within the group: prepend before the current first sibling.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id LIMIT 1',
    [groupId],
  )
  await repo.tx(async (tx) => {
    // The group id is MEMOIZED (a delete this session is invisible to it)
    // and `tx.create` only preflights that the parent ROW exists. Check
    // both derived levels: the root can be tombstoned while the group lives.
    await assertContainersLive(tx, repo, spec.workspaceId, spec.containerType)
    await tx.create(
      {
        id: blockId,
        workspaceId: spec.workspaceId,
        parentId: groupId,
        orderKey: keyAtStart(first?.order_key ?? null),
        // EMPTY, not a recorder's choice: live non-empty content is what
        // surfaces like find-replace treat as something a person wrote.
        content: '',
        properties: {},
      },
      { systemMint: true },
    )
    await repo.addTypeInTx(tx, blockId, spec.recordType.id, {})
    // LAST, per the ordering rule at the top of this module.
    assertEligible(repo, spec.workspaceId)
    await writeRecord(tx, blockId, spec.record)
  }, { scope: ChangeScope.Automation, telemetry: true, description: spec.description })
  spec.onCommitted?.(blockId)
  // Best-effort, deliberately AFTER commit — routing failure through the
  // caller's path would retry a write that already landed.
  try {
    await pruneGroup(repo, spec, groupId, blockId)
  } catch (err) {
    // Losing eligibility mid-pass is expected, not a fault. Anything else
    // means the bound isn't enforced, so it stays loud.
    if (!(err instanceof NoLongerEligible)) {
      console.error(`[${retentionDescription(spec)}] failed`, err)
    }
  }
  return { blockId, groupId }
}

/** Are this client's containers still live? A record under a tombstoned
 *  group/root is unreachable for good; sync can tombstone one without touching the record. */
const assertContainersLive = async (
  tx: Parameters<Parameters<Repo['tx']>[0]>[0],
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): Promise<void> => {
  const rootId = pluginUIStateBlockId(workspaceId, repo.user.id, containerType.id)
  for (const id of [rootId, clientGroupId(repo, workspaceId, containerType)]) {
    const row = await tx.get(id)
    if (!row || row.deleted) throw new NoLongerEligible()
  }
}

/** Update the record this session already owns. Here rather than at the
 *  call site so THE ORDERING RULE governs both writes. */
export const updateClientRecord = async (
  repo: Repo,
  spec: {
    workspaceId: string
    blockId: string
    containerType: TypeContribution
    description: string
    assertEligible: (repo: Repo, workspaceId: string) => void
    /** `tx.get` does not filter tombstones, so liveness is asked, not implied. */
    isStillOurs: (row: BlockData | null) => boolean
    record: RecordWrite
  },
): Promise<void> => {
  await repo.tx(async (tx) => {
    const row = await tx.get(spec.blockId)
    if (!spec.isStillOurs(row)) throw new NoLongerEligible()
    // The row's own liveness says nothing about its containers.
    await assertContainersLive(tx, repo, spec.workspaceId, spec.containerType)
    spec.assertEligible(repo, spec.workspaceId)
    await writeRecord(tx, spec.blockId, spec.record)
  }, { scope: ChangeScope.Automation, telemetry: true, description: spec.description })
}

/**
 * The ONE definition of "this client's records, newest first" — reader and
 * retention build their query from here. Three clauses: carries a record
 * (DEFENCE IN DEPTH — NULL sorts last, so this can't SAVE a row from
 * retention, only keep junk out of the reader's window); written from THIS
 * surface (a PWA and a tab share a client id but differ in timing;
 * unlabelled predates the field and is admitted); ordered by the RECORD's
 * timestamp, not tree position (a long-lived tab's row can be old by
 * position yet newest by sample — `(order_key, id)` only breaks ties).
 */
export const clientSeriesQuery = (
  select: string,
  opts: {
    groupId: string
    recordName: PropertyName
    /** Default: when persisted. A series whose write time can disagree
     *  with sample time (a RETRYING startup write) names its own. */
    orderField?: string
    deviceSurface: string
    /** DERIVED from the group id — the two disagree only for a row moved in by hand. */
    clientId: string
    /** Excluded BEFORE any offset — bounds records before the one just written. */
    excludeId?: string
    /** Placeholder count for `select`/`tail` changes with `excludeId`, so
     *  passed in rather than spliced. Wrong, it binds silently: a value at
     *  the offset slot can make `LIMIT -1 OFFSET 0`, deleting the series. */
    selectParams?: unknown[]
    /** Point lookup (e.g. `timeOriginMs`) — not bounded by a windowed read's candidate limit. */
    matchField?: { field: string; value: unknown }
    tail: string
    tailParams?: unknown[]
  },
): { sql: string; params: unknown[] } => {
  const record = jsonPathForProperty(opts.recordName)
  const label = `${record}.deviceLabel`
  const owner = `${record}.clientId`
  return {
    sql: `SELECT ${select} FROM blocks
           WHERE parent_id = ? AND deleted = 0
             ${opts.excludeId === undefined ? '' : 'AND id != ?'}
             AND json_extract(properties_json, ?) IS NOT NULL
             AND (json_extract(properties_json, ?) IS NULL
                  OR json_extract(properties_json, ?) LIKE ?)
             AND (json_extract(properties_json, ?) IS NULL
                  OR json_extract(properties_json, ?) = ?)
             ${opts.matchField === undefined ? '' : 'AND json_extract(properties_json, ?) = ?'}
           ORDER BY json_extract(properties_json, ?) DESC, order_key, id
           ${opts.tail}`,
    params: [
      ...(opts.selectParams ?? []),
      opts.groupId,
      ...(opts.excludeId === undefined ? [] : [opts.excludeId]),
      record, label, label, `${opts.deviceSurface}:%`,
      owner, owner, opts.clientId,
      ...(opts.matchField === undefined
        ? []
        : [`${record}.${opts.matchField.field}`, opts.matchField.value]),
      `${record}.${opts.orderField ?? 'recordedAt'}`,
      ...(opts.tailParams ?? []),
    ],
  }
}

/** Content this module wrote, vs typed by hand. Old records carried their
 *  own ISO timestamp and must stay prunable. ACCEPTED: a person typing an
 *  exact ISO timestamp into a telemetry row loses it. */
const isRecorderTitle = (content: string): boolean => {
  if (content === '') return true
  const parsed = Date.parse(content)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === content
}

/** Its own tx description — separate failure modes; sharing one would blur them in the tx log. */
const retentionDescription = (spec: ClientRecordSpec): string => `${spec.description} retention`

/** Drop this client's own records past `retain`, from the SAME series the
 *  reader pages. The row just written is excluded from the candidates
 *  rather than the offset, so the bound is `retain` older records ALONGSIDE it. */
const pruneGroup = async (
  repo: Repo,
  spec: ClientRecordSpec,
  groupId: string,
  keepId: string,
): Promise<void> => {
  // ORDER field, not `recordedAt` by assumption — what put a row past the bound.
  const orderField = spec.orderField ?? 'recordedAt'
  const q = clientSeriesQuery('id, json_extract(properties_json, ?) AS stamp', {
    groupId, recordName: spec.recordName, orderField,
    deviceSurface: deviceSurface(), clientId: getClientId(),
    excludeId: keepId,
    selectParams: [`${jsonPathForProperty(spec.recordName)}.${orderField}`],
    tail: 'LIMIT -1 OFFSET ?', tailParams: [spec.retain],
  })
  const stale = await repo.db.getAll<{ id: string; stamp: number | null }>(q.sql, q.params)
  if (stale.length === 0) return
  await repo.tx(async (tx) => {
    // Deletes are non-undoable, reached several awaits after the create's own gate — re-take it.
    assertStillWritable(repo, spec.workspaceId)
    // No user gesture/visible block here, so the content-deletion guards don't apply.
    for (const row of stale) {
      // Selection and this write are separated by an await, and rows are
      // hand-editable — re-take EVERY clause the selection used. `== null`
      // not `=== undefined` (a cleared record still holds JSON null). The
      // property clause below is LOAD-BEARING; `!now`/`deleted` is DEFENCE IN DEPTH.
      const now = await tx.get(row.id)
      if (!now || now.deleted || now.parentId !== groupId) continue
      const record = now.properties[spec.recordName]
      if (record == null) continue
      // Device-surface clause, re-taken: a row relabelled in the window
      // belongs to a different series the reader never counted.
      const label = (record as { deviceLabel?: unknown }).deviceLabel
      if (label != null && !String(label).startsWith(`${deviceSurface()}:`)) continue
      // Group id and owner can't disagree for a row this module wrote; one that does was moved in by hand.
      const owner = (record as { clientId?: unknown }).clientId
      if (owner != null && owner !== getClientId()) continue
      // Type tag by VALUE, not key — a hand-added type hides in the same
      // property. Absent is fine (pre-existing records carry none).
      const tags = now.properties[typesProp.name]
      if (tags != null && !(Array.isArray(tags)
        && tags.length === 1 && tags[0] === spec.recordType.id)) continue
      // Unchanged since selected — doesn't re-establish RANK (`Tx` has no
      // queries). ACCEPTED: needs a person hand-deleting newer rows mid-append.
      if ((record as Record<string, unknown>)[orderField] !== row.stamp) continue
      // Hand edits to the record — an Automation-scope delete has no undo.
      if (!isRecorderTitle(now.content)) continue
      // `types` is the type tag this module applies, not a hand edit.
      const ours = new Set([spec.recordName, typesProp.name])
      if (Object.keys(now.properties).some((key) => !ours.has(key))) continue
      // Anything else under a record was put there by hand — skip it. ONE
      // level, deliberately: descending treats a field row's own value
      // children as foreign, so no record is ever prunable in a
      // child-backed workspace — worse than the case it would catch.
      const foreign = await tx.childrenOf(row.id, undefined, { hidePropertyChildren: true })
      if (foreign.length > 0) continue
      // The SUBTREE, not the row: the record property can materialize
      // field/value rows that a bare delete would leave live under a tombstone.
      // eslint-disable-next-line no-restricted-syntax -- programmatic delete: telemetry retention
      await deleteSubtreeInTx(tx, row.id)
    }
  }, { scope: ChangeScope.Automation, telemetry: true, description: retentionDescription(spec) })
}
