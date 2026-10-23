/**
 * Claiming a name another live block already holds.
 *
 * The storage trigger is the final authority — a NEW claim on a held name
 * aborts the whole tx, and `Repo` translates the RAISE into `alias.collision`.
 * What a writer does about a conflict depends on who asked for the claim:
 *   - the user (a rename, an alias edit): refuse it. The preflight exists
 *     because a rejection built after the rollback cannot say which entries a
 *     merge would have to drop, and the toast's "Merge into…" offer is built
 *     from exactly that.
 *   - nobody (a restore, an undo, a get-or-create): yield the name, so the
 *     block stays reachable and the name stays with its holder.
 * Both ask `aliasClaimConflicts`, which is the trigger's rule, so neither can
 * disagree with it about what would abort.
 *
 * In core because the kernel's type naming, restore and undo need it as well as
 * the alias plugin's rename sync, and the kernel must not depend on the plugin.
 */

import { ProcessorRejection, type AnyPropertySchema, type BlockData, type Tx } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import {
  childContentsToEncodedPropertyValue,
  fieldValueChildren,
  unionValuesAcrossFieldRows,
} from '@/data/propertyChildren'
import type { SnapshotsMap } from '@/data/internals/txSnapshots'

/** A name claiming would abort on, and the other live blocks holding it. */
export interface AliasClaimConflict {
  alias: string
  holders: BlockData[]
}

/** Which of `aliases` a write would abort on if it made `blockId` claim them —
 *  the storage rule, asked before the write. A name the block already holds is
 *  not a new claim, even when a synced block co-claims it, because the
 *  maintenance trigger never re-inserts it; a new claim conflicts when any other
 *  live block holds the name. Blank names never conflict, as in the trigger. */
export const aliasClaimConflicts = async (
  tx: Tx,
  blockId: string,
  workspaceId: string,
  aliases: readonly string[],
): Promise<AliasClaimConflict[]> => {
  if (aliases.length === 0) return []
  const held = new Set(await tx.aliasesOf(blockId))
  const conflicts: AliasClaimConflict[] = []
  for (const alias of new Set(aliases)) {
    // Blank is defence in depth: no writer claims '', and the trigger skips it.
    if (alias === '' || held.has(alias)) continue
    const holders = (await tx.aliasClaimants(alias, workspaceId)).filter(block => block.id !== blockId)
    if (holders.length > 0) conflicts.push({alias, holders})
  }
  return conflicts
}

/** The names a stored alias bag claims, read the way the maintenance trigger
 *  reads it (`json_each` over `$.alias`, text values only) rather than through
 *  the codec, which reads a partly malformed bag as claiming nothing. Accepted
 *  gap: the trigger also indexes a NESTED array or object as its JSON text,
 *  which this skips — no name anyone links to is spelled that way. */
export const storedAliasNames = (properties: Record<string, unknown>): string[] => {
  const raw = properties[aliasesProp.name]
  const values = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' ? Object.values(raw) : [raw]
  return values.filter((value): value is string => typeof value === 'string')
}

/** `properties` with the alias bag replaced by `names`, as a clean string
 *  list. Whatever else a malformed bag held is not a name — the trigger never
 *  indexed it — and keeping it would make the rewritten bag fail the
 *  property's codec, which a child-backed workspace validates on write. */
const withAliasNames = (
  properties: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> => ({...properties, [aliasesProp.name]: aliasesProp.codec.encode([...names])})

/** The names a revival of `tombstone` brings back. Past the properties flip, a
 *  LIVE alias field row under it — a peer wrote it while the owner was dead —
 *  is the truth, and ordinary revival takes no value from the stale cell
 *  there; otherwise the stored bag is. Yielding from anything else would let
 *  the restore's alias write overrule children it never saw. */
const revivedAliasNames = async (tx: Tx, tombstone: BlockData): Promise<string[]> => {
  if (await tx.isPropertyChildBackedWorkspace(tombstone.workspaceId)) {
    let schema: AnyPropertySchema | null = null
    const perFieldRow: BlockData[][] = []
    for (const child of await tx.childrenOf(tombstone.id, undefined)) {
      if (child.isFieldForm !== true || child.referenceTargetId == null) continue
      const fieldSchema = tx.resolvePropertyFieldSchema(tombstone.workspaceId, child.referenceTargetId)
      if (fieldSchema?.name !== aliasesProp.name) continue
      schema = fieldSchema
      perFieldRow.push(await fieldValueChildren(tx, child.id))
    }
    if (schema !== null) {
      const live = childContentsToEncodedPropertyValue(
        schema, unionValuesAcrossFieldRows(schema, perFieldRow).map(value => value.content))
      return Array.isArray(live) ? live.filter((value): value is string => typeof value === 'string') : []
    }
  }
  return storedAliasNames(tombstone.properties)
}

/** Restore-time `properties` that yield every name another live block took
 *  while `id` was dead, or `undefined` when nothing was taken and the bag can
 *  come back as stored. A revival is a claim nobody asked for: aborting it
 *  leaves the block unrestorable for as long as the other holder lives, so the
 *  name stays with its current holder instead. */
export const restorePropertiesYieldingTakenAliases = async (
  tx: Tx,
  id: string,
): Promise<Record<string, unknown> | undefined> => {
  const tombstone = await tx.get(id)
  if (tombstone === null) return undefined
  // The restore indexes the stored bag: nothing taken there, and it comes back
  // as stored.
  if ((await takenAliases(tx, id, tombstone.workspaceId, storedAliasNames(tombstone.properties))).size === 0) {
    return undefined
  }
  const reviving = await revivedAliasNames(tx, tombstone)
  const taken = await takenAliases(tx, id, tombstone.workspaceId, reviving)
  return withAliasNames(tombstone.properties, reviving.filter(alias => !taken.has(alias)))
}

/** Which of `names` claiming for `id` would abort on, counting only the
 *  holders `counts` accepts. */
const takenAliases = async (
  tx: Tx,
  id: string,
  workspaceId: string,
  names: readonly string[],
  counts: (holderId: string, alias: string) => boolean = () => true,
): Promise<Set<string>> => {
  const conflicts = await aliasClaimConflicts(tx, id, workspaceId, names)
  return new Set(conflicts
    .filter(conflict => conflict.holders.some(holder => counts(holder.id, conflict.alias)))
    .map(conflict => conflict.alias))
}

/** Append `names` to `id`'s alias bag where missing — a derived claim whose
 *  names the caller proved free in this tx, so the write cannot collide.
 *  `skipMetadata`, because derived bookkeeping must not make the row look
 *  freshly user-edited. A malformed bag is left alone: appending means
 *  replacing the whole list, which could drop a name the trigger still
 *  indexes — worse than leaving these unclaimed. */
export const appendDerivedAliasClaims = async (
  tx: Tx,
  id: string,
  names: readonly string[],
): Promise<void> => {
  if (names.length === 0) return
  const row = await tx.get(id)
  if (row === null || row.deleted) return
  let existing: readonly string[]
  try {
    const encoded = row.properties[aliasesProp.name]
    existing = encoded === undefined ? [] : aliasesProp.codec.decode(encoded)
  } catch {
    return
  }
  const missing = [...new Set(names)].filter(name => !existing.includes(name))
  if (missing.length === 0) return
  await tx.setProperty(id, aliasesProp, [...existing, ...missing], {skipMetadata: true})
}

/** Every name this row actually claims, bag order first.
 *
 *  Read from the index rather than decoded from the property, because only the
 *  index knows what the trigger accepted — it takes text values from a bare
 *  scalar and from an OBJECT as well as from an array — and a name missed here
 *  is RELEASED by whatever writes the bag back, taking its links with it. Bag
 *  order is preserved for the plain string array everything writes, since the
 *  first entry reads as the page's primary name; anything the index knows
 *  beyond that is appended, which is also what repairs a malformed bag. */
export const claimedAliases = async (tx: Tx, block: BlockData): Promise<string[]> => {
  const indexed = await tx.aliasesOf(block.id)
  const known = new Set(indexed)
  const raw = block.properties[aliasesProp.name]
  const inBagOrder = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string' && known.has(value))
    : []
  return [...new Set([...inBagOrder, ...indexed])]
}

/** Closed set: the toast branches on these, and a typo in a free-form string
 *  would read as "no origin" and silently drop the merge offer. */
export type AliasCollisionOrigin = 'create' | 'content-rename'

export interface AliasClaimIntent {
  alias: string
  /** The claimant. Already holding the name is not a collision. */
  blockId: string
  workspaceId: string
  /** Entries the "Merge into…" action should drop from this block when the
   *  user accepts the merge — the names it is giving up by claiming. */
  dropSourceAliases?: readonly string[]
  /** What the user did, for the toast's wording and affordances. */
  collisionOrigin?: AliasCollisionOrigin
}

export const assertAliasClaimable = async (
  tx: Tx,
  {alias, blockId, workspaceId, dropSourceAliases = [], collisionOrigin}: AliasClaimIntent,
): Promise<void> => {
  // The storage rule, not "does anyone else claim it": a name this block
  // already holds is not refused even when a synced block co-claims it, or
  // every rename of a co-claimant would abort on the name it keeps.
  const [conflict] = await aliasClaimConflicts(tx, blockId, workspaceId, [alias])
  if (conflict === undefined) return
  const claimant = conflict.holders[0]!
  throw new ProcessorRejection(
    `Alias "${alias}" is already used by another block`,
    'alias.collision',
    {
      alias,
      conflictingBlockId: claimant.id,
      // 80 chars: the toast doesn't render long strings well.
      conflictingBlockTitle: claimant.content.slice(0, 80),
      workspaceId,
      attemptedOn: blockId,
      dropSourceAliases: [...dropSourceAliases],
      ...(collisionOrigin === undefined ? {} : {collisionOrigin}),
    },
  )
}

/** A stuck replay row's target with names yielded, and which names. */
export interface ReplayYield {
  target: BlockData
  taken: ReadonlySet<string>
}

/** The stuck undo / redo rows that must yield a name, keyed by id — each with
 *  its target rewritten. For a replay pass that made no progress: the worklist
 *  already reorders a handoff inside the entry, so a holder that matters here
 *  is one that still holds the name when the replay ends — a block outside the
 *  entry, or one inside it whose own target keeps the name. Waiting on it would
 *  fail the undo, and every retry of it, for as long as that holder lives.
 *
 *  Only the cells change: in a child-backed workspace the caller also releases
 *  the yielded names' value children once the replay has written them all. */
export const yieldNamesHeldPastReplay = async (
  tx: Tx,
  stuck: ReadonlyArray<readonly [string, BlockData | null]>,
  snapshots: SnapshotsMap,
  direction: 'before' | 'after',
): Promise<Map<string, ReplayYield>> => {
  const keepsPastReplay = (holderId: string, alias: string): boolean => {
    const entry = snapshots.get(holderId)
    if (entry === undefined) return true
    const target = entry[direction]
    return target !== null && !target.deleted && storedAliasNames(target.properties).includes(alias)
  }
  const yields = new Map<string, ReplayYield>()
  for (const [id, target] of stuck) {
    if (target === null || target.deleted) continue
    const names = storedAliasNames(target.properties)
    const taken = await takenAliases(tx, id, target.workspaceId, names, keepsPastReplay)
    if (taken.size === 0) continue
    const kept = names.filter(alias => !taken.has(alias))
    yields.set(id, {target: {...target, properties: withAliasNames(target.properties, kept)}, taken})
  }
  return yields
}
