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
import {
  canonicalAliasReaderFromRepo,
  canonicalAliasReaderFromTx,
  refuseTypedClaimant,
  resolveCanonicalAliasOwner,
  restorePropertiesStrippingAliases,
} from '@/data/targets'

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

/** Read-only alias-first resolution: which block currently IS this kernel
 *  page. Returns the same id `getOrCreateKernelPage` would resolve to — the
 *  canonical-alias claimant if one is eligible, else the deterministic id —
 *  but writes NOTHING: it neither creates, restores, nor repairs, and the
 *  returned id may name a tombstone or no row at all.
 *
 *  For callers that need the page's IDENTITY without wanting to bring it into
 *  existence — e.g. a read that should fail loudly when the page is missing,
 *  or navigation that wants to check liveness itself. Callers that need the
 *  page to exist must use `getOrCreateKernelPage` and take its returned
 *  block's `.id`; per `canonicalAliasReaderFromTx`, a prediction taken outside
 *  a write tx is a hint that must be re-resolved inside one before any write.
 *
 *  Mirrors `predictedJournalId` in `@/plugins/daily-notes`, and applies the
 *  SAME adoption guard `getOrCreateKernelPage` does, so the two agree on which
 *  claimants are eligible. */
export const predictKernelPageId = async (
  repo: Repo,
  workspaceId: string,
  spec: KernelPageSpec,
): Promise<string> => {
  const resolved = await resolveCanonicalAliasOwner(
    canonicalAliasReaderFromRepo(repo),
    [spec.alias],
    workspaceId,
    kernelPageBlockId(workspaceId, spec.namespace),
    refuseTypedClaimant([PAGE_TYPE, spec.markerType]),
  )
  return resolved.id
}

/** Get-or-create a per-workspace kernel page. Resolves ALIAS-FIRST (issue
 *  #378, repo-owner decision — "try id if not, use alias, everywhere"):
 *  if a live block already owns `spec.alias` (e.g. the canonical page was
 *  deleted and the user then aliased a different page to the same name),
 *  ADOPT it — apply `PAGE_TYPE` + `spec.markerType` to THAT block — rather
 *  than minting/restoring at the deterministic id. Adoption mutates the
 *  user's existing block (it gains the type + marker); that's the point
 *  of "their page becomes the kernel page", not a side effect. Falls back
 *  to the deterministic id when nobody claims the alias (fresh workspace,
 *  or the claimant is later deleted → re-mint) — including when an
 *  eligible-looking claimant is refused by `resolveCanonicalAliasOwner`'s
 *  guard (already-typed claimant — genuinely ambiguous, left unchanged;
 *  see its docblock). Otherwise repairs a live page missing the expected
 *  types/alias, or restores a soft-deleted row. */
export const getOrCreateKernelPage = async (
  repo: Repo,
  workspaceId: string,
  spec: KernelPageSpec,
): Promise<Block> => {
  const id = kernelPageBlockId(workspaceId, spec.namespace)
  const aliases: readonly string[] = [spec.alias]
  const orderKey = spec.orderKey ?? 'a0'
  // Widen the default guard to also allow `spec.markerType`: without this,
  // a claimant THIS resolver itself adopted and marker-typed on a prior
  // call would fail its own guard on the next call (the marker type it
  // just applied now reads as "extra"), permanently falling back to the
  // dead deterministic id and colliding on re-claim. See
  // `refuseTypedClaimant`'s docblock.
  const guard = refuseTypedClaimant([PAGE_TYPE, spec.markerType])

  const predicted = await resolveCanonicalAliasOwner(
    canonicalAliasReaderFromRepo(repo), aliases, workspaceId, id, guard,
  )

  const live = await repo.load(predicted.id)
  if (live) {
    const currentAliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      !hasBlockType(live, PAGE_TYPE) ||
      !hasBlockType(live, spec.markerType) ||
      !includesAll(currentAliases, aliases)
    if (!needsRepair) return repo.block(predicted.id)

    const typeSnapshot = repo.snapshotTypeRegistries()
    let finalId = predicted.id
    await repo.tx(async tx => {
      // Re-resolve fresh inside the tx — see canonicalAliasReaderFromTx.
      const resolved = await resolveCanonicalAliasOwner(
        canonicalAliasReaderFromTx(tx), aliases, workspaceId, id, guard,
      )
      finalId = resolved.id
      const current = await tx.get(resolved.id)
      if (!current || current.deleted) return
      const txAliases = stringListProperty(current.properties[aliasesProp.name])
      if (!includesAll(txAliases, aliases)) {
        await tx.setProperty(resolved.id, aliasesProp, mergeStrings([...aliases, ...txAliases]))
      }
      await repo.addTypeInTx(tx, resolved.id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
      await repo.addTypeInTx(tx, resolved.id, spec.markerType, {[aliasesProp.name]: aliases}, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault})
    return repo.block(finalId)
  }

  const typeSnapshot = repo.snapshotTypeRegistries()
  let finalId = id
  await repo.tx(async tx => {
    const resolved = await resolveCanonicalAliasOwner(
      canonicalAliasReaderFromTx(tx), aliases, workspaceId, id, guard,
    )
    if (resolved.adopted) {
      // A live block already owns `spec.alias` — adopt it instead of
      // minting/restoring the deterministic id (issue #378). The alias
      // is already theirs (that's how the lookup found them); just apply
      // the type tags.
      finalId = resolved.id
      await repo.addTypeInTx(tx, resolved.id, PAGE_TYPE, {[aliasesProp.name]: aliases}, typeSnapshot)
      await repo.addTypeInTx(tx, resolved.id, spec.markerType, {[aliasesProp.name]: aliases}, typeSnapshot)
      return
    }
    finalId = id
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      // The tombstone's stored alias bag can hold an entry a different
      // live block claimed while this page was dead (issue #378) —
      // restoring it as-is would re-insert that stale claim and abort
      // the whole tx. Strip it here; the setProperty below re-claims
      // exactly the canonical alias set. (The CANONICAL alias itself
      // being squatted is handled above via `resolved.adopted` — this
      // branch only runs when nobody claims it, so the reclaim below is
      // safe.)
      const restoredProperties = await restorePropertiesStrippingAliases(tx, id)
      await tx.restore(id, {content: spec.alias, properties: restoredProperties})
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

  return repo.block(finalId)
}
