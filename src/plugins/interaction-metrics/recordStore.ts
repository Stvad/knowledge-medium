/**
 * The one way a metrics record reaches the graph.
 *
 * Both recorders keep the same shape — a per-client group under a hidden
 * ui-state subtree, one prepended block per session, typed, carrying a single
 * identity-codec property — so the guards belonging to that shape live here
 * once: eligibility re-taken inside the transaction, `skipMetadata` so
 * bookkeeping does not float the row into Recents, the type tag landing in the
 * same transaction as the create.
 *
 * Only what the SHAPE guarantees belongs here. A recorder with a stronger rule
 * passes it (`assertEligible`), and retention remains the interaction
 * recorder's own — sharing a write path does not make two recorders identical.
 */
import { ChangeScope, type TypeContribution } from '@/data/api'
import type { Repo } from '@/data/repo'
import {
  getPluginUIStateBlock,
  getPluginUIStateChild,
  pluginUIStateBlockId,
  stateChildBlockId,
} from '@/data/stateBlocks.js'
import { jsonPathForProperty } from '@/data/internals/typedBlockQuery.js'
import { keyAtStart } from '@/data/orderKey.js'
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import { v4 as uuidv4 } from 'uuid'
import { assertStillWritable, NoLongerEligible } from './sessionContext.js'

export interface ClientRecordSpec {
  workspaceId: string
  /** Type of the hidden container this recorder's groups live under. */
  containerType: TypeContribution
  /** Type applied to the record row itself, so the rows are queryable and
   *  auditable rather than inferred from tree position. */
  recordType: TypeContribution
  /** `repo.tx` description — for the tx log and for reading the diff later. */
  description: string
  /** Row content — legible in the tree, and FTS-indexed, so keep it dull. */
  content: string
  /** Re-taken as the first operation inside the create transaction. Defaults to
   *  `assertStillWritable`, which is all the shared shape can know; a recorder
   *  with a STRONGER rule must pass it, because the shared default cannot see
   *  it. The interaction recorder's attributability rule is exactly that case. */
  assertEligible?: (repo: Repo, workspaceId: string) => void
  /** Records to keep in this client's group. Required, so a recorder cannot
   *  reach the graph without stating a bound. */
  retain: number
  /** Name of the record property — retention only ever considers rows CARRYING
   *  one, since these groups are inspectable and can hold a hand-created child
   *  that must never be reachable by a cleanup pass. The NAME rather than the
   *  JSON path because retention needs both forms (SQL and in-transaction), and
   *  deriving the path from the name here is what keeps them the same rule. */
  recordName: string
  /** Writes the record property. Runs inside the create transaction. */
  setProperty: (tx: Parameters<Parameters<Repo['tx']>[0]>[0], blockId: string) => Promise<void>
  /** Called as soon as the record is DURABLE, before the retention pass this
   *  call also runs. A caller that publishes ownership from the return value
   *  instead leaves a window in which the row is committed and readable but
   *  unclaimed — and the reader excludes this session's record by id, so it
   *  would count the live session twice. */
  onCommitted?: (blockId: string) => void
}

/** This client's group id, DERIVED — no read, no create. The reader matches on
 *  exactly this parent, so anything that has to agree with the reader about
 *  where records live must use this rather than a remembered id. */
export const clientGroupId = (
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): string =>
  stateChildBlockId(
    pluginUIStateBlockId(workspaceId, repo.user.id, containerType.id),
    getClientId(),
  )

/** This client's group under `containerType`, creating it if absent. */
export const ensureClientGroup = async (
  repo: Repo,
  workspaceId: string,
  containerType: TypeContribution,
): Promise<string> => {
  const root = await getPluginUIStateBlock(repo, workspaceId, repo.user, containerType)
  const clientId = getClientId()
  const group = await getPluginUIStateChild(
    root,
    clientId,
    // Titled with the device label so two browsers sharing a platform string
    // stay distinguishable in the tree; KEYED on the opaque client id so every
    // device converges on its own group after sync.
    `${getDeviceLabel()} · ${clientId.slice(0, 8)}`,
  )
  return group.id
}

/**
 * Append one record to this client's group and return its block id.
 *
 * Create, type tag and property land in ONE transaction: split across two, a
 * failure or a closed page between them leaves a durable typed child with no
 * record on it, and the reader's window is consumed by rows carrying nothing.
 */
export const appendClientRecord = async (
  repo: Repo,
  recordTx: Repo['tx'],
  spec: ClientRecordSpec,
): Promise<{ blockId: string; groupId: string }> => {
  const groupId = await ensureClientGroup(repo, spec.workspaceId, spec.containerType)
  const blockId = uuidv4()
  // Newest-first within the group: prepend before the current first sibling.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id LIMIT 1',
    [groupId],
  )
  await recordTx(async (tx) => {
    ;(spec.assertEligible ?? assertStillWritable)(repo, spec.workspaceId)
    await tx.create(
      {
        id: blockId,
        workspaceId: spec.workspaceId,
        parentId: groupId,
        orderKey: keyAtStart(first?.order_key ?? null),
        content: spec.content,
        properties: {},
      },
      { systemMint: true },
    )
    await repo.addTypeInTx(tx, blockId, spec.recordType.id, {})
    await spec.setProperty(tx, blockId)
  }, { scope: ChangeScope.Automation, description: spec.description })
  spec.onCommitted?.(blockId)
  // Best-effort, and deliberately AFTER the record is committed and reported.
  // Routing a retention failure through the caller's failure path retries a
  // write that already landed: the startup recorder appends up to three records
  // for one boot, and the interaction recorder forgets the row it owns and
  // opens a second. The next append re-attempts the prune.
  try {
    await pruneGroup(repo, recordTx, spec, groupId, blockId)
  } catch (err) {
    // Losing eligibility mid-pass is the expected refusal, not a fault; the next
    // append re-attempts. Anything else means the bound is not being enforced,
    // which is how a series goes unbounded, so it stays loud.
    if (!(err instanceof NoLongerEligible)) {
      console.error(`[${retentionDescription(spec)}] failed`, err)
    }
  }
  return { blockId, groupId }
}

/** Its own tx description, not the record's: these are separate transactions
 *  with separate failure modes, and a shared description makes them
 *  indistinguishable in the tx log — where attributing a write to a call site is
 *  the whole point. */
const retentionDescription = (spec: ClientRecordSpec): string => `${spec.description} retention`

/** Drop this client's own records past `retain`.
 *
 *  Ordered by `(order_key, id)`, the tree's canonical sibling order, so that
 *  retention and `loadRecords` agree on which row sits at the boundary. Jitter
 *  makes a key collision improbable enough that no test reproduces one, so the
 *  tiebreaker is unpinned defence in depth.
 *
 *  Only THIS client's group, so two devices can never fight over the same rows;
 *  and only rows carrying a record, for both the offset and the deletion set —
 *  counting a hand-created child toward the offset would eventually hand user
 *  content to `tx.delete`. */
const pruneGroup = async (
  repo: Repo,
  recordTx: Repo['tx'],
  spec: ClientRecordSpec,
  groupId: string,
  keepId: string,
): Promise<void> => {
  const stale = await repo.db.getAll<{ id: string }>(
    `SELECT id FROM blocks
      WHERE parent_id = ? AND deleted = 0 AND id != ?
        AND json_extract(properties_json, ?) IS NOT NULL
      ORDER BY order_key, id
      LIMIT -1 OFFSET ?`,
    [groupId, keepId, jsonPathForProperty(spec.recordName), spec.retain],
  )
  if (stale.length === 0) return
  await recordTx(async (tx) => {
    // Deletes are the one thing here that cannot be taken back — `Automation` is
    // non-undoable — and this transaction is reached several awaits after the
    // create's own gate, across a `getAll` over the whole group. Re-take it.
    assertStillWritable(repo, spec.workspaceId)
    // Retention of a recorder's own rows in a hidden ui-state subtree: no user
    // gesture and no user-visible block, so the deletion guards — which exist to
    // protect user-authored content — have nothing to say here.
    for (const row of stale) {
      // The selection above is separated from this write by an await, and these
      // rows are hand-editable: a row that stopped being one of ours in that
      // window — stripped by a person, moved out of the group, or edited on
      // another device and synced in — is user content by the time we get the
      // lock. Re-take EVERY clause the selection used, or the re-take admits
      // rows the query would have excluded.
      //
      // `== null` and not `=== undefined`: the property codec is
      // `optionalIdentity`, whose `encode(undefined)` is `null`, so clearing the
      // record leaves the key present holding JSON null — which `json_extract`
      // reports as absent and a strict check would read as still ours.
      // `!now` and `now.deleted` are defence in depth and unpinnable through
      // this path — a hard delete cannot happen here and `tx.delete` no-ops on a
      // tombstone. The parent and property clauses below are load-bearing.
      const now = await tx.get(row.id)
      if (!now || now.deleted || now.parentId !== groupId) continue
      if (now.properties[spec.recordName] == null) continue
      // eslint-disable-next-line no-restricted-syntax -- programmatic delete: telemetry retention
      await tx.delete(row.id)
    }
  }, { scope: ChangeScope.Automation, description: retentionDescription(spec) })
}
