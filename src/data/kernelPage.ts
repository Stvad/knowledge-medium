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
import { restorePropertiesStrippingAliases } from '@/data/targets'

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

/** Get-or-create a per-workspace kernel page. Repairs a live page that's
 *  missing the expected types or alias; restores a soft-deleted row;
 *  otherwise creates fresh.
 *
 *  On a READ-ONLY workspace it only GETS: the create/repair transactions are
 *  skipped and the handle is returned as-is.
 *
 *  This is an ERGONOMIC guard, not a safety one — a distinction I originally
 *  got backwards here. The kernel already refuses the write: `BlockDefault` is
 *  `readOnly: 'reject'` in `CHANGE_SCOPE_POLICIES`, and the commit pipeline
 *  throws `ReadOnlyError` before anything is written. So without this, a viewer
 *  merely opening a kernel-page surface got an unhandled rejection out of an
 *  action handler; nothing was ever written, and nothing was left to be
 *  RLS-rejected on sync. What this buys is that the viewer sees an empty page
 *  instead of an error.
 *
 *  The ordinary read-only case is unaffected: the id is deterministic, so a
 *  page the owner already created has synced and resolves normally.
 *
 *  It belongs here rather than in each surface because every one of them —
 *  daily notes, SRS review, locations, media capture, the Readwise backlog —
 *  reaches the same throw through this one function.
 *
 *  UNDOABLE, deliberately. Every caller bootstraps inside a `repo.undoGroup`
 *  alongside the action that needed the page (`getOrCreateDailyNote`,
 *  `createOrFindPlace`, media capture), so the create merges into that
 *  operation's entry and is reverted only by reverting the operation — which is
 *  what undo should do. A caller that writes with `skipUndo` and does NOT group
 *  leaves this create alone on the stack; that is the caller's to account for,
 *  not a reason to make the bootstrap invisible to undo for everyone. */
export const getOrCreateKernelPage = async (
  repo: Repo,
  workspaceId: string,
  spec: KernelPageSpec,
): Promise<Block> => {
  const id = kernelPageBlockId(workspaceId, spec.namespace)
  const aliases: readonly string[] = [spec.alias]
  const orderKey = spec.orderKey ?? 'a0'
  // Checked rather than trusted from the type, because the callers this is
  // newly exposed to are the ones the type does not reach: a dynamic extension
  // is transpiled, not typechecked. Without this the omission surfaces several
  // frames down as "type id undefined is not registered", which sends the
  // author off to add a type seed instead of to the field they left out.
  if (spec.markerType === undefined) {
    throw new Error(
      'KernelPageSpec.markerType is required — pass a marker block-type to query the page by, or null for a page reached only by its id and alias.',
    )
  }
  const types: readonly string[] =
    spec.markerType === null ? [PAGE_TYPE] : [PAGE_TYPE, spec.markerType]

  const tagTypes = async (tx: Tx, snapshot: TypeRegistrySnapshot): Promise<void> => {
    for (const type of types) {
      await repo.addTypeInTx(tx, id, type, {[aliasesProp.name]: aliases}, snapshot)
    }
  }

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
   *  What counts as foreign is `classifyOccupant`'s to say, not this file's —
   *  including that it outranks `tombstoned`, which is what stops the restore
   *  branch below from ever being offered another workspace's row. */
  const refuseForeign = (occupant: BlockData): void => {
    if (classifyOccupant(occupant, {workspaceId}).verdict === 'foreign') {
      throw new DeterministicIdCrossWorkspaceError(id, occupant.workspaceId, workspaceId)
    }
  }

  const live = await repo.load(id)

  // Read-only: GET, never create or repair — see the doc above for why this is
  // ergonomics rather than safety.
  //
  // Placed AFTER the occupant read and behind `refuseForeign`, not before
  // either. Being unable to write is not the same as being entitled to read:
  // returning the handle unchecked would hand a caller another workspace's
  // block under this workspace's identity. It also stays after the spec
  // validation above, so a malformed call still fails loudly for the author
  // instead of silently no-op-ing on whichever session happens to be read-only.
  //
  // KNOWN LIMIT: `repo.load` selects `deleted = 0`, so a TOMBSTONED foreign row
  // is invisible here and this returns its handle unrefused. The handle
  // resolves to a deleted block, so nothing renders — but it is the one path
  // that can hand back an id without `classifyOccupant` having spoken. Closing
  // it wants a tombstone-inclusive read on `Repo`.
  if (repo.isReadOnly) {
    if (live) refuseForeign(live)
    return repo.block(id)
  }

  if (live) {
    refuseForeign(live)
    const currentAliases = stringListProperty(live.properties[aliasesProp.name])
    const needsRepair =
      types.some(type => !hasBlockType(live, type)) ||
      !includesAll(currentAliases, aliases)
    if (!needsRepair) return repo.block(id)

    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      const current = await tx.get(id)
      if (!current || current.deleted) return
      refuseForeign(current)
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
    if (existing) refuseForeign(existing)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      // The tombstone's stored alias bag can hold an entry a different
      // live block claimed while this page was dead (issue #378) —
      // restoring it as-is would re-insert that stale claim and abort
      // the whole tx. Strip it here; the setProperty below re-claims
      // exactly the canonical alias set.
      const restoredProperties = await restorePropertiesStrippingAliases(tx, id)
      await tx.restore(id, {content: spec.alias, properties: restoredProperties})
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
