/**
 * The one way a metrics record reaches the graph.
 *
 * Both recorders keep the same shape — a per-client group under a hidden
 * ui-state subtree, one prepended block per session, typed, carrying a single
 * identity-codec property — and they kept it by copying. Every guard that
 * belonged to that shape (write eligibility re-taken inside the transaction,
 * `skipMetadata` so bookkeeping does not float the block into Recents, the
 * type tag landing in the same transaction as the create, the recorder's own
 * transactions being counted) had to be applied twice, and four consecutive
 * review rounds found one of the two places missed. Written once, it cannot be
 * missed once.
 */
import { ChangeScope, type TypeContribution } from '@/data/api'
import type { Repo } from '@/data/repo'
import { getPluginUIStateBlock, getPluginUIStateChild } from '@/data/stateBlocks.js'
import { keyAtStart } from '@/data/orderKey.js'
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import { v4 as uuidv4 } from 'uuid'
import { assertStillWritable } from './sessionContext.js'

export interface ClientRecordSpec {
  workspaceId: string
  /** Type of the hidden container this recorder's groups live under. */
  containerType: TypeContribution
  /** Type applied to the record row itself, so the rows are queryable and
   *  auditable rather than inferred from tree position. */
  recordType: TypeContribution
  /** `repo.tx` description; also what the own-write accounting recognises. */
  description: string
  /** Row content — legible in the tree, and FTS-indexed, so keep it dull. */
  content: string
  /** Writes the record property. Runs inside the create transaction. */
  setProperty: (tx: Parameters<Parameters<Repo['tx']>[0]>[0], blockId: string) => Promise<void>
}

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
): Promise<string> => {
  const groupId = await ensureClientGroup(repo, spec.workspaceId, spec.containerType)
  const blockId = uuidv4()
  // Newest-first within the group: prepend before the current first sibling.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1',
    [groupId],
  )
  await recordTx(async (tx) => {
    assertStillWritable(repo, spec.workspaceId)
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
  return blockId
}
