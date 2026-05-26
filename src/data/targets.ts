/**
 * Target-block primitives for parseReferences + Roam import (spec §7,
 * §13.1, v4.31).
 *
 *   Layer 1 — `createOrRestoreTargetBlock(tx, args)` is the shared
 *   primitive: SELECT-then-branch via `tx.createOrGet`, restore
 *   tombstones via `tx.restore`. Same semantics every domain helper
 *   gets the catch-and-restore boilerplate from. Returns
 *   `{id, inserted}` where `inserted: true` covers both fresh-insert
 *   and tombstone-restore (both are "this tx wrote the row").
 *
 *   Layer 2 — `ensureAliasTarget` (here) and `ensureDailyNoteTarget`
 *   (in `@/plugins/daily-notes`) are thin per-domain wrappers. Each
 *   computes its own deterministic id, picks `freshContent` (the
 *   alias text — so the freshly-materialised seat renders with a
 *   non-empty title; steady-state drift after a rename is still
 *   allowed and healed by the A3 sync rule), and supplies an
 *   `onInsertedOrRestored` callback that writes the alias list via
 *   `tx.setProperty`.
 *   Per-domain also drives the cleanup-eligibility routing in §7.6:
 *   only ensureAliasTarget results enter the newlyInsertedAliasTargetIds
 *   list passed to `references.cleanupOrphanAliases` (date-shaped aliases
 *   never enter the cleanup list — daily notes persist regardless of
 *   whether a referencing block is removed within 4s).
 *
 * Why `tx.createOrGet` doesn't restore on tombstone (v4.26):  Restore
 * is domain policy. The primitive throws DeletedConflictError loudly
 * and lets the domain helper decide what fields to refresh. The
 * shared helper here is the canonical refresh policy for parseReferences
 * + Roam import.
 *
 * Indexed-deterministic seat ids: rather than a single deterministic
 * id per `(alias, workspaceId)`, alias seats live in a probed sequence
 * `id₀, id₁, id₂, …` derived from `uuidv5("${ws}:${alias}:${i}",
 * ALIAS_NS)`. `ensureAliasTarget` walks the sequence until it finds
 * an empty slot (insert here) or a live row that already claims the
 * alias (reuse). Live rows that claim a different alias — typical
 * post-rename case — and tombstones are skipped. Two offline clients
 * with the same world-state probe the same way and land on the same
 * slot, preserving the deterministic-id convergence guarantee. The
 * "claims this alias?" check is what preserves the happy-path
 * convergence at slot 0; without it the probe would always run past
 * the existing seat.
 *
 * NOTE: `createOrRestoreTargetBlock` is helper-layer, NOT exposed on
 * the public Tx surface (per v4.31). Plugin authors writing their own
 * deterministic-id flows can import it from `@/data/targets`.
 */

import { v5 as uuidv5 } from 'uuid'
import {
  DeletedConflictError,
  type ProcessorReadDb,
  type Tx,
  type TypeRegistrySnapshot,
} from '@/data/api'
import type { Repo } from '@/data/repo'
import { keyAtEnd } from './orderKey'
import { aliasesProp } from './internals/coreProperties'
import { typesProp } from './properties'
import { PAGE_TYPE } from './blockTypes'

/** Layer 1 args. */
export interface CreateOrRestoreArgs {
  id: string
  workspaceId: string
  parentId: string | null
  orderKey: string
  /** Applied on both insert and restore. */
  freshContent: string
  /** Optional callback invoked after the row is inserted OR restored
   *  (NOT on the live-row-hit path). Used by per-domain wrappers to
   *  write properties (e.g. the alias list via tx.setProperty) that
   *  need codec encoding. The callback runs synchronously inside the
   *  outer tx; awaitable. */
  onInsertedOrRestored?: (tx: Tx, id: string) => Promise<void> | void
}

/** Shared primitive — see file header. Returns `{id, inserted}`;
 *  `inserted: true` means this tx wrote the row (fresh or restored). */
export const createOrRestoreTargetBlock = async (
  tx: Tx,
  args: CreateOrRestoreArgs,
): Promise<{ id: string; inserted: boolean }> => {
  try {
    const result = await tx.createOrGet({
      id: args.id,
      workspaceId: args.workspaceId,
      parentId: args.parentId,
      orderKey: args.orderKey,
      content: args.freshContent,
    })
    if (result.inserted && args.onInsertedOrRestored) {
      await args.onInsertedOrRestored(tx, args.id)
    }
    return result
  } catch (err) {
    if (err instanceof DeletedConflictError) {
      // Tombstone — restore + apply onInsertedOrRestored. v4.26 / v4.27
      // / v4.31 design: the typed `tx.restore` primitive accepts a
      // BlockDataPatch, so we can refresh content in the same UPDATE.
      // Property writes that need codec encoding still go through
      // tx.setProperty inside the callback.
      await tx.restore(args.id, {content: args.freshContent})
      if (args.onInsertedOrRestored) {
        await args.onInsertedOrRestored(tx, args.id)
      }
      return {id: args.id, inserted: true}
    }
    // DeterministicIdCrossWorkspaceError, etc. — domain bug, surface
    // loudly. Plugin authors calling this primitive on a deterministic
    // id whose namespace doesn't include workspace_id should expect
    // this throw and not catch it.
    throw err
  }
}

// ──── Deterministic-id namespaces (UUIDv5) ────

/** Namespace for alias-seat ids. The probe input is
 *  `${workspaceId}:${alias}:${index}`; two workspaces typing the same
 *  alias get distinct seats, and within a workspace the index lets
 *  parallel probes resolve to additional slots when slot 0 was claimed
 *  by a previous alias that has since been renamed. */
const ALIAS_NS = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'

/** Probe cap. The expected indexed depth is 0–2 in realistic
 *  workloads (one rename per alias is rare; multiple is rarer). A cap
 *  surfaces anomalous state — a saturated alias namespace, an infinite
 *  probe loop from a buggy read source — as a loud error rather than a
 *  hang. */
const MAX_PROBE_SLOTS = 64

/** Deterministic id for the `index`-th alias-seat slot. Slot 0 is the
 *  happy-path id; higher slots are claimed by probes that skipped a
 *  live row claiming a different alias (post-rename) or a tombstoned
 *  prior occupant. Two clients in the same world-state hit the same
 *  index for a given `(alias, workspaceId)`. */
export const computeAliasSeatId = (
  alias: string,
  workspaceId: string,
  index: number = 0,
): string => uuidv5(`${workspaceId}:${alias}:${index}`, ALIAS_NS)

/** Alias-seat row shape the probe needs. Carries enough info to detect
 *  a *pristine transient tombstone* — a slot that cleanup soft-deleted
 *  without the user ever touching the page (no content drift, no extra
 *  properties, no children). Those are restorable in place; everything
 *  else (drifted content, user-added props/children, explicit page
 *  delete after edits) stays skipped so we don't resurrect content the
 *  user already discarded. */
export interface AliasSeatRow {
  deleted: boolean
  aliases: readonly string[]
  content: string
  /** True iff properties contain ONLY `alias` and `types`, and `types`
   *  is exactly `[PAGE_TYPE]` — the shape `ensureAliasTarget` writes.
   *  Any extra key or extra type means the user (or another plugin)
   *  touched the seat. */
  hasSeedProperties: boolean
  /** True iff some live block has parent_id = this row's id. Soft-
   *  delete does not cascade today, so a tombstoned seat with live
   *  children is by definition not transient. */
  hasLiveChildren: boolean
}

/** Read function passed to `resolveAliasSeatId`. Returns the row at
 *  `id` (live or tombstoned) or `null` if no row exists. Concrete
 *  readers below: `aliasSeatReaderFromTx` (inside ensureAliasTarget,
 *  honours read-your-own-writes) and `aliasSeatReaderFromDb`
 *  (read-phase of post-commit processors, hits committed state). */
export type AliasSeatReader = (id: string) => Promise<AliasSeatRow | null>

const decodeAliasList = (encoded: unknown): readonly string[] => {
  if (encoded === undefined) return []
  try {
    return aliasesProp.codec.decode(encoded)
  } catch {
    return []
  }
}

const decodeTypesList = (encoded: unknown): readonly string[] => {
  if (encoded === undefined) return []
  try {
    return typesProp.codec.decode(encoded)
  } catch {
    return []
  }
}

const checkSeedProperties = (propertyKeys: readonly string[], types: readonly string[]): boolean =>
  propertyKeys.length === 2
  && propertyKeys.includes(aliasesProp.name)
  && propertyKeys.includes(typesProp.name)
  && types.length === 1
  && types[0] === PAGE_TYPE

/** Tx-scoped reader: `tx.get` returns the row including tombstones,
 *  with codec-encoded properties (we decode `alias` and `types` here).
 *  `tx.childrenOf` filters `deleted = 0`, which is what we want — only
 *  live children count as a "user touched" signal at probe time. */
export const aliasSeatReaderFromTx = (tx: Tx): AliasSeatReader =>
  async (id) => {
    const block = await tx.get(id)
    if (block === null) return null
    const propertyKeys = Object.keys(block.properties)
    const aliases = decodeAliasList(block.properties[aliasesProp.name])
    const types = decodeTypesList(block.properties[typesProp.name])
    const hasSeedProperties = checkSeedProperties(propertyKeys, types)
    // childrenOf needs a workspaceId pin or a non-null parent; the row
    // we just loaded gives us workspaceId, so the lookup is well-scoped
    // even for workspace-root seats (parentId === null is the typical
    // alias-seat shape).
    const children = await tx.childrenOf(id, block.workspaceId)
    return {
      deleted: block.deleted,
      aliases,
      content: block.content,
      hasSeedProperties,
      hasLiveChildren: children.length > 0,
    }
  }

/** Committed-state SQL reader: used by the read phase of post-commit
 *  processors that don't hold a tx. Reads `deleted` + `properties_json`
 *  + `content` + a live-child existence probe. Robust to property-JSON
 *  parse errors (returns `aliases: []`, `hasSeedProperties: false` so
 *  the probe steps past the slot — same behavior as a row that doesn't
 *  claim our alias). */
export const aliasSeatReaderFromDb = (db: ProcessorReadDb): AliasSeatReader =>
  async (id) => {
    const row = await db.getOptional<{deleted: 0 | 1; properties_json: string; content: string}>(
      `SELECT deleted, properties_json, content FROM blocks WHERE id = ?`,
      [id],
    )
    if (row === null) return null
    let aliases: readonly string[] = []
    let hasSeedProperties = false
    try {
      const parsed = JSON.parse(row.properties_json) as Record<string, unknown>
      aliases = decodeAliasList(parsed[aliasesProp.name])
      const types = decodeTypesList(parsed[typesProp.name])
      hasSeedProperties = checkSeedProperties(Object.keys(parsed), types)
    } catch {
      // Malformed properties_json — treat as non-seed; probe steps past.
    }
    // Partial index idx_blocks_parent_order covers (parent_id, deleted=0).
    const childRow = await db.getOptional<{one: 1}>(
      `SELECT 1 AS one FROM blocks WHERE parent_id = ? AND deleted = 0 LIMIT 1`,
      [id],
    )
    return {
      deleted: row.deleted === 1,
      aliases,
      content: row.content,
      hasSeedProperties,
      hasLiveChildren: childRow !== null,
    }
  }

/** Predicate: this tombstoned slot looks like it was created by
 *  `ensureAliasTarget` for `alias` and was never touched before
 *  cleanup tombstoned it — i.e., it's safe to restore in place via
 *  `createOrRestoreTargetBlock` instead of probing past it. Keeping
 *  the predicate strict (exact seed shape + content + alias match +
 *  no live children) means a user who explicitly deleted a real
 *  page never sees their content resurrected on a [[…]] retype. */
const isRestorableTransientTombstone = (row: AliasSeatRow, alias: string): boolean =>
  row.deleted
  && row.aliases.length === 1
  && row.aliases[0] === alias
  && row.content === alias
  && row.hasSeedProperties
  && !row.hasLiveChildren

/** Walk indexed-deterministic seat slots for `(alias, workspaceId)`
 *  until one of:
 *   - empty slot → return that id (caller will insert),
 *   - live row claiming `alias` → return that id (reuse / convergence),
 *   - pristine transient tombstone for `alias` → return that id (caller
 *     restores via `createOrRestoreTargetBlock`'s `DeletedConflictError`
 *     branch). This keeps slot 0 reusable for hot names instead of
 *     burning a fresh slot every cleanup cycle.
 *  Skips live rows claiming a different alias (post-rename) and
 *  tombstones that fail the restorable predicate (drifted content,
 *  user-added props, live children — i.e. anything that wasn't a
 *  pristine cleanup target).
 *
 *  Two clients with the same observed world-state probe the same way
 *  and land on the same slot — that's the deterministic-id convergence
 *  guarantee. The restorable predicate is a pure function of the row,
 *  so both clients evaluate it identically. Clients with divergent
 *  state may pick different slots, but PowerSync convergence + the
 *  alias-lookup query handle this case: `block_aliases` is exact-match
 *  by alias text, so a second parseReferences pass on either client
 *  resolves through the lookup rather than the probe. */
export const resolveAliasSeatId = async (
  read: AliasSeatReader,
  alias: string,
  workspaceId: string,
): Promise<string> => {
  for (let index = 0; index < MAX_PROBE_SLOTS; index++) {
    const id = computeAliasSeatId(alias, workspaceId, index)
    const row = await read(id)
    if (row === null) return id
    if (row.deleted) {
      if (isRestorableTransientTombstone(row, alias)) return id
      continue
    }
    if (row.aliases.includes(alias)) return id
    // Live row claims a different alias — typical post-rename. Probe next.
  }
  throw new Error(
    `resolveAliasSeatId: ${MAX_PROBE_SLOTS} slots exhausted for alias "${alias}" in workspace "${workspaceId}"`,
  )
}

// Note on alias-collision detection: this used to live here as
// `findAliasClaimant` walking seat-id slots. That was incorrect — it
// only found claimants whose block id matched
// `computeAliasSeatId(alias, ws, *)`, missing blocks that claim an
// alias but were created via `tx.create` with an unrelated id. The
// correct primitive is `tx.aliasLookup(alias, workspaceId)` which
// reads the trigger-maintained `block_aliases` table directly,
// covering every claimant regardless of id provenance. See
// docs/alias-rename-cases.html ("Alias collisions") and
// `tx.aliasLookup` in tx.ts.

// ──── Layer 2 — per-domain wrappers ────

/** Ensure a stub-block seat exists for `alias` in `workspaceId`. The
 *  seat is the indexed-deterministic id returned by
 *  `resolveAliasSeatId` — NOT a canonical id for "the block named
 *  alias". Callers should always lookup-first (a real block claiming
 *  the alias has its own id and that's what references should resolve
 *  to); this helper is only invoked when the lookup misses, to
 *  materialise the stub the reference will point at. Inserts at
 *  workspace-root with `content` defaulted to the alias text (so the
 *  freshly-materialised page renders with the alias as its title
 *  instead of empty); sets `aliases` property to `[alias]` on
 *  insert/restore. Steady-state `content !== aliases[0]` is still
 *  allowed — any rename produces it — this is just the creation-time
 *  default. Returns `{id, inserted}`. */
export const ensureAliasTarget = async (
  tx: Tx,
  repo: Repo,
  alias: string,
  workspaceId: string,
  typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries(),
): Promise<{ id: string; inserted: boolean }> => {
  const id = await resolveAliasSeatId(aliasSeatReaderFromTx(tx), alias, workspaceId)
  return createOrRestoreTargetBlock(tx, {
    id,
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(),
    freshContent: alias,
    onInsertedOrRestored: async (tx, id) => {
      await tx.setProperty(id, aliasesProp, [alias])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [alias]}, typeSnapshot)
    },
  })
}
