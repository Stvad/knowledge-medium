/** Per-workspace kernel-page bootstrap. Each workspace owns a small set
 *  of singleton pages (Journal, Properties, Types, Recents, Locations,
 *  Assets — and whatever a plugin roots its own content under). They
 *  share a shape: deterministic uuid-v5 id derived from `workspaceId`,
 *  alias-based human-readable surface, navigable as a normal page
 *  (`PAGE_TYPE`) plus — for the ones reached by query — a marker
 *  block-type so `block_types`-indexed lookups can find them, and
 *  soft-delete-restore on first reach.
 *
 *  Restoring is what distinguishes a kernel page from a RECORD. This is
 *  machinery the app needs present, so a tombstone is brought back; a
 *  record's deletion was a decision, so `getOrCreateTypedChild` refuses
 *  one instead. Both derive their id the same way — `@/data/derivedIds`
 *  says which to reach for.
 *
 *  Idempotent across offline launches — two clients booting offline
 *  converge on the same row at next sync.
 */

import { ChangeScope, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { Block } from '@/data/block'
import { derivedBlockId } from '@/data/derivedIds'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasBlockType } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'

const stringListProperty = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []

const includesAll = (existing: readonly string[], expected: readonly string[]): boolean =>
  expected.every(value => existing.includes(value))

const mergeStrings = (values: readonly string[]): string[] => Array.from(new Set(values))

export interface KernelPageSpec {
  /** uuid v5 namespace; the page id is `derivedBlockId({namespace, key:
   *  workspaceId})`. Choose a fresh, randomly-generated namespace per page
   *  kind so two kernel pages never collide on the same row — and never
   *  change one afterwards, which would orphan every page already written
   *  under it. */
  namespace: string
  /** Primary alias. Used as the page's `content` and as the sole entry
   *  of its aliases prop. */
  alias: string
  /** Marker block-type tagged alongside `PAGE_TYPE`. The marker is what
   *  callers query for (`subscribeBlocks({types: [markerType]})`).
   *
   *  Optional, for the page that is reached only by its derived id and its
   *  alias — the Journal is the one such page today. Adding a marker to a kind
   *  that shipped without one is a data change (every existing row needs the
   *  tag), not a default. */
  markerType?: string
  /** OrderKey for the page under the workspace root. Defaults to 'a0';
   *  kernel pages share this value and tiebreak by id (stable enough
   *  for navigation, no uniqueness invariant to maintain). */
  orderKey?: string
}

/** Deterministic block id for a kernel page in a given workspace. The
 *  workspace id IS the whole key — one page of each kind per workspace. */
export const kernelPageBlockId = (workspaceId: string, namespace: string): string =>
  derivedBlockId({namespace, key: workspaceId})

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
  const types: readonly string[] =
    spec.markerType === undefined ? [PAGE_TYPE] : [PAGE_TYPE, spec.markerType]

  const tagTypes = async (tx: Tx, snapshot: TypeRegistrySnapshot): Promise<void> => {
    for (const type of types) {
      await repo.addTypeInTx(tx, id, type, {[aliasesProp.name]: aliases}, snapshot)
    }
  }

  const live = await repo.load(id)
  if (live) {
    const currentAliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      types.some(type => !hasBlockType(live, type)) ||
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
      await tagTypes(tx, typeSnapshot)
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
      await tagTypes(tx, typeSnapshot)
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey,
      content: spec.alias,
    }, {systemMint: true})
    await tagTypes(tx, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(id)
}
