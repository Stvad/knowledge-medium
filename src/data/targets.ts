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
import { aliasesProp, addBlockTypeToProperties } from './properties'
import { PAGE_TYPE } from './blockTypes'

/** Layer 1 args. */
export interface CreateOrRestoreArgs {
  id: string
  workspaceId: string
  parentId: string | null
  orderKey: string
  /** Applied on both insert and restore. */
  freshContent: string
  /** Mint the row as a speculative engine default (`system:<userId>`
   *  author) so it yields to an older-but-authoritative server row under
   *  the reconcile gate. Applies to the INSERT path only — a tombstone
   *  restore is an update and stays user-authored (create-only, per
   *  TxInsertOpts). Seat materializers (alias / daily-note seats,
   *  shortcuts) set this; content-bearing creators (Roam import, which
   *  uses its own tx.create, not this primitive) do not. */
  systemMint?: boolean
  /** Strip the tombstone bag's `aliases` key in the SAME restore UPDATE.
   *  Set by callers whose `onInsertedOrRestored` OWNS the alias write
   *  (the alias/daily seat wrappers): a tombstoned seat can carry a
   *  stale claim, and restoring it as-is trips the alias-uniqueness
   *  trigger against the current claimant before the callback can
   *  correct it (whole-tx rollback; found by
   *  referencesRecompute.fuzz.test.ts). Callers that do NOT re-write
   *  aliases (sidebar shortcuts, media assets) must leave this unset so
   *  a user-set alias survives the restore. */
  stripAliasesOnRestore?: boolean
  /** Optional callback invoked after the row is inserted OR restored
   *  (NOT on the live-row-hit path). Used by per-domain wrappers to
   *  write properties (e.g. the alias list via tx.setProperty) that
   *  need codec encoding. The callback runs synchronously inside the
   *  outer tx; awaitable. On the insert path, these same-tx writes
   *  inherit the system author when `systemMint` is set. */
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
    }, {systemMint: args.systemMint})
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
      //
      // See `stripAliasesOnRestore`'s docblock for why alias-owning
      // callers strip the tombstone bag's aliases in the same UPDATE
      // (stale-claim resurrection trips the uniqueness trigger and rolls
      // back the whole tx; found by referencesRecompute.fuzz.test.ts) —
      // and why non-alias-owning callers must NOT (a user-set alias on
      // a restored shortcuts/media row must survive).
      if (args.stripAliasesOnRestore) {
        const tombstone = await tx.get(args.id)
        const restoredProperties = {...(tombstone?.properties ?? {})}
        delete restoredProperties[aliasesProp.name]
        await tx.restore(args.id, {content: args.freshContent, properties: restoredProperties})
      } else {
        await tx.restore(args.id, {content: args.freshContent})
      }
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

/** Single source of truth for the freshly-materialised alias-seat
 *  shape. `ensureAliasTarget` writes a row whose `(content, properties)`
 *  must equal this seed; the restorable-tombstone predicate compares
 *  tombstoned rows back against it. Routing both sites through one
 *  function means drift becomes a one-place syntactic edit instead of
 *  a coordinated update; the `ensureAliasTarget writes the seed shape`
 *  test in `targets.test.ts` is the drift detector. */
export interface AliasSeatSeed {
  content: string
  /** Codec-encoded property map exactly as it lands in `properties_json`.
   *  Mirrors the `tx.setProperty` + `addTypeInTx` calls in
   *  `ensureAliasTarget`'s callback. */
  properties: Readonly<Record<string, unknown>>
}

export const aliasSeatSeed = (alias: string): AliasSeatSeed => ({
  content: alias,
  // `addBlockTypeToProperties` is the sanctioned no-Repo path for raw
  // BlockData construction — it's the same primitive Roam-import uses
  // and keeps us out of the `no-direct-types-prop-writes` lint that
  // guards the live Repo type-invariant surface. The matching live-tx
  // write in `ensureAliasTarget` runs `repo.addTypeInTx`, which
  // produces the same encoded `types` value.
  properties: addBlockTypeToProperties(
    { [aliasesProp.name]: aliasesProp.codec.encode([alias]) },
    PAGE_TYPE,
  ),
})

/** Alias-seat row shape the probe needs. Exposes the raw stored
 *  `content` + encoded `properties` so the restorability predicate can
 *  compare to `aliasSeatSeed` directly; `hasLiveChildren` is the one
 *  signal that needs a separate read (the partial index covers it). */
export interface AliasSeatRow {
  deleted: boolean
  content: string
  /** Codec-encoded property map, exactly as stored on the row. */
  properties: Readonly<Record<string, unknown>>
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

/** Tx-scoped reader: `tx.get` returns the row including tombstones, with
 *  codec-encoded properties (passed through as-is). `tx.childrenOf`
 *  filters `deleted = 0`, which is what we want — only live children
 *  count as a "user touched" signal at probe time. */
export const aliasSeatReaderFromTx = (tx: Tx): AliasSeatReader =>
  async (id) => {
    const block = await tx.get(id)
    if (block === null) return null
    // childrenOf needs a workspaceId pin or a non-null parent; the row
    // we just loaded gives us workspaceId, so the lookup is well-scoped
    // even for workspace-root seats (parentId === null is the typical
    // alias-seat shape).
    const children = await tx.childrenOf(id, block.workspaceId)
    return {
      deleted: block.deleted,
      content: block.content,
      properties: block.properties,
      hasLiveChildren: children.length > 0,
    }
  }

/** Committed-state SQL reader: used by the read phase of post-commit
 *  processors that don't hold a tx. Reads `deleted` + `properties_json`
 *  + `content` + a live-child existence probe. Robust to property-JSON
 *  parse errors (returns `properties: {}` so the predicate fails; the
 *  probe steps past the slot). */
export const aliasSeatReaderFromDb = (db: ProcessorReadDb): AliasSeatReader =>
  async (id) => {
    const row = await db.getOptional<{deleted: 0 | 1; properties_json: string; content: string}>(
      `SELECT deleted, properties_json, content FROM blocks WHERE id = ?`,
      [id],
    )
    if (row === null) return null
    let properties: Record<string, unknown> = {}
    try {
      properties = JSON.parse(row.properties_json) as Record<string, unknown>
    } catch {
      // Malformed properties_json — leave properties empty; predicate fails.
    }
    // Partial index idx_blocks_parent_order covers (parent_id, deleted=0).
    const childRow = await db.getOptional<{one: 1}>(
      `SELECT 1 AS one FROM blocks WHERE parent_id = ? AND deleted = 0 LIMIT 1`,
      [id],
    )
    return {
      deleted: row.deleted === 1,
      content: row.content,
      properties,
      hasLiveChildren: childRow !== null,
    }
  }

/** Value-equality on encoded property values. The codec output is
 *  JSON-stringifiable (the storage layer encodes properties_json via
 *  JSON.stringify), so structural comparison via JSON text is exact for
 *  the current alias-seat seed (string-list values). If the seed ever
 *  grows to include object-shaped property values, swap to a real
 *  deep-equal — JSON.stringify key order isn't guaranteed across all
 *  inputs (it is for arrays and our current property values, but the
 *  contract weakens if we add unordered objects). */
const encodedPropertyEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const propertiesMatchSeed = (
  rowProps: Readonly<Record<string, unknown>>,
  seedProps: Readonly<Record<string, unknown>>,
): boolean => {
  const seedKeys = Object.keys(seedProps)
  if (Object.keys(rowProps).length !== seedKeys.length) return false
  for (const k of seedKeys) {
    if (!encodedPropertyEqual(rowProps[k], seedProps[k])) return false
  }
  return true
}

/** Shape half of the seat predicates, shared with the reference-drop
 *  orphan reaper (issue #402): the row's `(content, properties)` still
 *  equals `aliasSeatSeed(content)` — a machine-minted seat nothing ever
 *  drifted (a rename, a user-added property, or an extra alias all break
 *  the match). Liveness/children checks are the caller's: the tombstone
 *  predicate below wants no live children at all, while the reaper
 *  additionally tolerates the seat's own GENERATED property children in
 *  a child-backed workspace. */
export const matchesAliasSeatSeed = (
  row: Pick<AliasSeatRow, 'content' | 'properties'>,
): boolean => {
  if (row.content === '') return false
  const seed = aliasSeatSeed(row.content)
  return propertiesMatchSeed(row.properties, seed.properties)
}

/** Predicate: this tombstoned slot was created by `ensureAliasTarget`
 *  for `alias` and was never touched before cleanup tombstoned it — i.e.
 *  the row's `(content, properties)` still equals `aliasSeatSeed(alias)`
 *  and there are no live children. Anything else (drifted content,
 *  user-added props, leftover children) stays skipped so a user's
 *  explicit deletion of a real page is never undone by a [[…]] retype. */
const isRestorableTransientTombstone = (row: AliasSeatRow, alias: string): boolean => {
  if (!row.deleted) return false
  if (row.hasLiveChildren) return false
  const seed = aliasSeatSeed(alias)
  if (row.content !== seed.content) return false
  return propertiesMatchSeed(row.properties, seed.properties)
}

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
/** Is `id` one of the deterministic seat-slot ids for `(alias,
 *  workspaceId)`? Pure compute over the same slot window the probe
 *  walks. The reference-drop orphan reaper (issue #402) uses this as
 *  its machine-mint discriminator: a user-created page can share the
 *  seat SEED SHAPE exactly (quick-find's create-page writes content +
 *  alias + PAGE_TYPE), but it gets a random uuid — only
 *  `ensureAliasTarget` mints rows at these ids, so shape + slot-id
 *  together mean "ours to reap". */
export const isAliasSeatSlotId = (
  id: string,
  alias: string,
  workspaceId: string,
): boolean => {
  for (let index = 0; index < MAX_PROBE_SLOTS; index++) {
    if (computeAliasSeatId(alias, workspaceId, index) === id) return true
  }
  return false
}

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
    if (decodeAliasList(row.properties[aliasesProp.name]).includes(alias)) return id
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
  // Lookup-first INSIDE the tx, not just at the caller's read phase:
  // the read-phase lookup can go stale between plan build and apply —
  // if a live block claimed the alias in that gap, minting the seat
  // below would set the same alias on a second row, trip the
  // block_aliases_workspace_alias_unique trigger, and roll back the
  // caller's whole write tx (for parseReferences that means the source
  // keeps its mark with no derived ref, and nothing re-fires — found by
  // referencesRecompute.fuzz.test.ts). Binding to the claimant instead
  // converges with what a fresh read-phase lookup would have produced.
  // The seat-slot probe can't catch this case: it only inspects
  // deterministic seat ids, and a claimant created via tx.create has an
  // unrelated id (see the findAliasClaimant note above).
  const claimant = await tx.aliasLookup(alias, workspaceId)
  if (claimant !== null) return {id: claimant.id, inserted: false}
  const id = await resolveAliasSeatId(aliasSeatReaderFromTx(tx), alias, workspaceId)
  const seed = aliasSeatSeed(alias)
  return createOrRestoreTargetBlock(tx, {
    id,
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(),
    freshContent: seed.content,
    stripAliasesOnRestore: true,
    // A freshly-probed alias seat is a speculative default: if the server
    // already has a real page for this alias, the local seat must yield.
    systemMint: true,
    // The setProperty + addTypeInTx pair below must produce exactly
    // `seed.properties` on disk; the `ensureAliasTarget writes the seed
    // shape` test in targets.test.ts asserts this and is the contract
    // between writer and the restorability predicate.
    onInsertedOrRestored: async (tx, id) => {
      await tx.setProperty(id, aliasesProp, [alias])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [alias]}, typeSnapshot)
    },
  })
}
