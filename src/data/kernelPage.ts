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

import { ChangeScope, type BlockData, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
import { Block } from '@/data/block'
import { classifyOccupant, derivedBlockId } from '@/data/derivedIds'
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
import { adoptTypedBlock } from '@/data/typedRecords'

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
   *  `null` for a page reached only by its derived id and its alias — the
   *  Journal is the one such page today. Required-but-nullable rather than
   *  optional on purpose: a forgotten marker used to throw on the first run
   *  (`addTypeInTx` rejects an unregistered type id), and if omitting it were
   *  merely allowed, the page would instead be created with `PAGE_TYPE` alone
   *  and every `types`-indexed query for it would come back empty forever —
   *  including the repair path here, which derives from the same list and so
   *  would never notice. Writing `null` makes that a decision.
   *
   *  Adding a marker to a kind that shipped without one is a data change
   *  (every existing row needs the tag), not a default. */
  markerType: string | null
  /** OrderKey for the page under the workspace root. Defaults to 'a0';
   *  kernel pages share this value and tiebreak by id (stable enough
   *  for navigation, no uniqueness invariant to maintain). */
  orderKey?: string
}

/** Deterministic block id for a kernel page in a given workspace. The
 *  workspace id IS the whole key — one page of each kind per workspace.
 *
 *  Note for anyone MOVING an existing page onto this: `pluginBlockId(ws, NS,
 *  key)` hashes `${ws}:${key}`, so reusing its namespace constant here yields
 *  a DIFFERENT id — same namespace, different formula. The old page does not
 *  come with it; it stays where it is with all of its children, and this mints
 *  an empty one beside it. Either leave the existing page on the id it already
 *  has, or migrate deliberately — and in that order: clear the old page's
 *  alias BEFORE calling `getOrCreateKernelPage`, because this claims the same
 *  alias and aliases are unique per workspace, so the create aborts the whole
 *  transaction while the old page still holds the name. Then re-parent its
 *  children and delete it. Nothing here detects the situation for you. */
export const kernelPageBlockId = (workspaceId: string, namespace: string): string =>
  derivedBlockId({namespace, key: workspaceId})

/** The types a kernel page carries — `PAGE_TYPE`, plus the marker when the
 *  spec names one.
 *
 *  Shared rather than inlined because it feeds TWO things that must agree:
 *  the tags `getOrCreateKernelPage` applies, and the allow-list its adoption
 *  guard (`refuseTypedClaimant`) is built from — in this function and in
 *  `predictKernelPageId`. If those drift, a claimant this resolver adopted
 *  and tagged on one call is refused by the other as "already typed",
 *  which falls the caller back to a deterministic id whose alias the
 *  claimant now holds — an `alias.collision` that rolls back the whole
 *  transaction (issue #378).
 *
 *  The `undefined` check is here rather than at a call site for the same
 *  reason: it is checked at all because the callers this is newly exposed to
 *  are the ones the type does not reach — a dynamic extension is transpiled,
 *  not typechecked. Without it the omission surfaces several frames down as
 *  "type id undefined is not registered", which sends the author off to add a
 *  type seed instead of to the field they left out. */
const kernelPageTypes = (spec: KernelPageSpec): readonly string[] => {
  if (spec.markerType === undefined) {
    throw new Error(
      'KernelPageSpec.markerType is required — pass a marker block-type to query the page by, or null for a page reached only by its id and alias.',
    )
  }
  return spec.markerType === null ? [PAGE_TYPE] : [PAGE_TYPE, spec.markerType]
}

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
    refuseTypedClaimant(kernelPageTypes(spec)),
  )
  return resolved.id
}

/** Get-or-create a per-workspace kernel page. Resolves ALIAS-FIRST (issue
 *  #378, repo-owner decision — "try id if not, use alias, everywhere"):
 *  if a live block already owns `spec.alias` (e.g. the canonical page was
 *  deleted and the user then aliased a different page to the same name),
 *  ADOPT it — apply `PAGE_TYPE` and the marker, if there is one, to THAT
 *  block — rather than minting/restoring at the deterministic id. Adoption
 *  mutates the user's existing block (it gains the types); that's the point
 *  of "their page becomes the kernel page", not a side effect. Falls back
 *  to the deterministic id when nobody claims the alias (fresh workspace,
 *  or the claimant is later deleted → re-mint) — including when an
 *  eligible-looking claimant is refused by `resolveCanonicalAliasOwner`'s
 *  guard (already-typed claimant — genuinely ambiguous, left unchanged;
 *  see its docblock). Otherwise repairs a live page missing the expected
 *  types/alias, or restores a soft-deleted row.
 *
 *  Alias-first is why the returned block's id is NOT always
 *  `kernelPageBlockId(workspaceId, spec.namespace)`. Callers that need to
 *  know WHERE the page is must read `.id` off the result rather than
 *  re-deriving it. */
export const getOrCreateKernelPage = async (
  repo: Repo,
  workspaceId: string,
  spec: KernelPageSpec,
): Promise<Block> => {
  const id = kernelPageBlockId(workspaceId, spec.namespace)
  const aliases: readonly string[] = [spec.alias]
  const orderKey = spec.orderKey ?? 'a0'
  const types = kernelPageTypes(spec)

  /** `targetId` rather than the outer `id` because alias-first resolution can
   *  land this page on a claimant's id — see `guard` below. */
  const tagTypes = async (
    tx: Tx, targetId: string, snapshot: TypeRegistrySnapshot,
  ): Promise<void> => {
    for (const type of types) {
      await repo.addTypeInTx(tx, targetId, type, {[aliasesProp.name]: aliases}, snapshot)
    }
  }

  // The guard allows exactly the types this page itself applies, rather than
  // `refuseTypedClaimant`'s bare `[PAGE_TYPE]` default: without the marker in
  // the allow-list, a claimant THIS resolver adopted and marker-typed on a
  // prior call would fail its own guard on the next call (the marker it just
  // applied now reads as "extra"), permanently falling back to the dead
  // deterministic id and colliding on re-claim. For a markerless page
  // (`markerType: null` — the Journal) `types` is `[PAGE_TYPE]`, i.e. the
  // default. See `refuseTypedClaimant`'s docblock.
  const guard = refuseTypedClaimant(types)

  /** A row at this id belonging to some OTHER workspace is never ours to
   *  touch, whatever the namespace says.
   *
   *  Neither read that finds an occupant is workspace-scoped — `repo.load` and
   *  `tx.get` both select on id alone — and the two branches they feed repair
   *  properties and resurrect tombstones. Left unchecked, a colliding id lets
   *  this rewrite aliases and types, or undelete content, in a workspace the
   *  caller never named: the one thing a workspace-global write must not do.
   *
   *  The engine already refuses this inside `createOrGet`; the create path
   *  below therefore cannot reach a foreign row, and only the adopt and
   *  restore paths need it said again. Raising the engine's own error keeps
   *  one meaning for the condition across every deterministic-id caller.
   *
   *  The ALIAS-first path (issue #378) is the one occupant this never has to
   *  judge, and not by omission: `aliasLookup` selects on
   *  `block_aliases.workspace_id`, which the three alias triggers write from
   *  `blocks.workspace_id` and rewrite on `UPDATE OF … workspace_id`, so an
   *  alias claimant is in `workspaceId` by construction. That is why the error
   *  below can name the outer `id` — the only occupant that can be foreign is
   *  the one reached by id alone.
   *
   *  What counts as foreign is `classifyOccupant`'s to say, not this file's —
   *  including that it outranks `tombstoned`, which is what stops the restore
   *  branch below from ever being offered another workspace's row. */
  const refuseForeign = (occupant: BlockData): void => {
    if (classifyOccupant(occupant, {workspaceId}).verdict === 'foreign') {
      throw new DeterministicIdCrossWorkspaceError(id, occupant.workspaceId, workspaceId)
    }
  }

  const predicted = await resolveCanonicalAliasOwner(
    canonicalAliasReaderFromRepo(repo), aliases, workspaceId, id, guard,
  )

  const live = await repo.load(predicted.id)
  if (live) {
    refuseForeign(live)
    const currentAliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      types.some(type => !hasBlockType(live, type)) ||
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
      refuseForeign(current)
      const txAliases = stringListProperty(current.properties[aliasesProp.name])
      if (!includesAll(txAliases, aliases)) {
        await tx.setProperty(resolved.id, aliasesProp, mergeStrings([...aliases, ...txAliases]))
      }
      await tagTypes(tx, resolved.id, typeSnapshot)
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
      // minting/restoring the deterministic id (issue #378). The alias is
      // already theirs (that's how the lookup found them), so the whole adopt
      // is the missing type tags — which is `adoptTypedBlock`'s job, and this
      // is the "answered `taken`, then found the real record another way" case
      // its docblock names. `tagTypes`' alias default is not lost by going
      // through it: `addType`'s initial values are only-if-empty and a
      // claimant necessarily has the alias property already.
      finalId = resolved.id
      await adoptTypedBlock(repo, tx, resolved.claimant, types, typeSnapshot)
      return
    }
    finalId = id
    const existing = await tx.get(id)
    if (existing) refuseForeign(existing)
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
      await tagTypes(tx, id, typeSnapshot)
      return
    }
    await tx.create({
      id,
      workspaceId,
      parentId: null,
      orderKey,
      content: spec.alias,
    }, {systemMint: true})
    await tagTypes(tx, id, typeSnapshot)
  }, {scope: ChangeScope.BlockDefault})

  return repo.block(finalId)
}
