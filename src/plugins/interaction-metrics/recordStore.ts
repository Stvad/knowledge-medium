/**
 * The one way a metrics record reaches the graph.
 *
 * Both recorders keep the same shape — a per-client group under a hidden
 * ui-state subtree, one prepended block per session, typed, carrying a single
 * identity-codec property — and used to keep it by copying, so every guard
 * belonging to the shape had to be applied twice.
 *
 * What lives here is only what the shape itself guarantees. A recorder with a
 * STRONGER rule than the shape knows about must pass it (`assertEligible`), and
 * retention is still the interaction recorder's own: sharing a write path does
 * not make two recorders identical, and assuming it does is how the extraction
 * itself dropped a check on its first attempt.
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
  /** `repo.tx` description — for the tx log and for reading the diff later. */
  description: string
  /** Row content — legible in the tree, and FTS-indexed, so keep it dull. */
  content: string
  /** Re-taken as the first operation inside the create transaction. Defaults to
   *  `assertStillWritable`, which is all the shared shape can know; a recorder
   *  with a STRONGER rule must pass it, because the shared default cannot see
   *  it. The interaction recorder's attributability rule is exactly that case. */
  assertEligible?: (repo: Repo, workspaceId: string) => void
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
): Promise<{ blockId: string; groupId: string }> => {
  const groupId = await ensureClientGroup(repo, spec.workspaceId, spec.containerType)
  const blockId = uuidv4()
  // Newest-first within the group: prepend before the current first sibling.
  const first = await repo.db.getOptional<{ order_key: string }>(
    'SELECT order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key LIMIT 1',
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
  return { blockId, groupId }
}
