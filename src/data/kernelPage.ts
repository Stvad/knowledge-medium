/** Per-workspace kernel-page bootstrap. Each workspace owns a small set
 *  of singleton pages (Properties, Types, future Saved Queries /
 *  Dashboards / Command palette). They share a shape: deterministic
 *  uuid-v5 id derived from `workspaceId`, alias-based human-readable
 *  surface, navigable as a normal page (`PAGE_TYPE`) plus a marker
 *  block-type so `block_types`-indexed lookups can find them, and
 *  soft-delete-restore on first reach.
 *
 *  Idempotent across offline launches — two clients booting offline
 *  converge on the same row at next sync.
 */

import { v5 as uuidv5 } from 'uuid'
import { ChangeScope } from '@/data/api'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasBlockType } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'

const stringListProperty = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []

const includesAll = (existing: readonly string[], expected: readonly string[]): boolean =>
  expected.every(value => existing.includes(value))

const mergeStrings = (values: readonly string[]): string[] => Array.from(new Set(values))

export interface KernelPageSpec {
  /** uuid v5 namespace; the page id is `uuidv5(workspaceId, namespace)`.
   *  Choose a fresh, randomly-generated namespace per page kind so two
   *  kernel pages never collide on the same row. */
  namespace: string
  /** Primary alias. Used as the page's `content` and as the sole entry
   *  of its aliases prop. */
  alias: string
  /** Marker block-type tagged alongside `PAGE_TYPE`. The marker is what
   *  callers query for (`subscribeBlocks({types: [markerType]})`). */
  markerType: string
  /** OrderKey for the page under the workspace root. Defaults to 'a0';
   *  kernel pages share this value and tiebreak by id (stable enough
   *  for navigation, no uniqueness invariant to maintain). */
  orderKey?: string
}

/** Deterministic block id for a kernel page in a given workspace. */
export const kernelPageBlockId = (workspaceId: string, namespace: string): string =>
  uuidv5(workspaceId, namespace)

/** Get-or-create a per-workspace kernel page. Repairs a live page that's
 *  missing the expected types or alias; restores a soft-deleted row;
 *  otherwise creates fresh. */
export const getOrCreateKernelPage = async (
  repo: Repo,
  workspaceId: string,
  spec: KernelPageSpec,
): Promise<Block> => {
  const id = kernelPageBlockId(workspaceId, spec.namespace)
  const aliases: readonly string[] = [spec.alias]
  const orderKey = spec.orderKey ?? 'a0'

  const live = await repo.load(id)
  if (live) {
    const currentAliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      !hasBlockType(live, PAGE_TYPE) ||
      !hasBlockType(live, spec.markerType) ||
      !includesAll(currentAliases, aliases)
    if (!needsRepair) return repo.block(id)

    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(id)
      if (!current || current.deleted) return
      const txAliases = stringListProperty(current.properties[aliasesProp.name])
      if (!includesAll(txAliases, aliases)) {
        await tx.setProperty(id, aliasesProp, mergeStrings([...aliases, ...txAliases]))
      }
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
      await repo.addTypeInTx(tx, id, spec.markerType, {[aliasesProp.name]: aliases}, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})
    return repo.block(id)
  }

  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: spec.alias})
      await tx.setProperty(id, aliasesProp, [...aliases])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
      await repo.addTypeInTx(tx, id, spec.markerType, {[aliasesProp.name]: aliases}, typeSnapshot)
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey,
      content: spec.alias,
    }, {systemMint: true})
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
    await repo.addTypeInTx(tx, id, spec.markerType, {[aliasesProp.name]: aliases}, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}
