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
 *   Layer 2 — `ensureAliasTarget` / `ensureDailyNoteTarget` are
 *   thin per-domain wrappers. Each computes its own deterministic id,
 *   picks `freshContent` (empty string for v1 callers), and supplies
 *   an `onInsertedOrRestored` callback that writes the alias list via
 *   `tx.setProperty`. Per-domain also drives the cleanup-eligibility
 *   routing in §7.6: only ensureAliasTarget results enter the
 *   newlyInsertedAliasTargetIds list passed to
 *   `backlinks.cleanupOrphanAliases` (date-shaped aliases never enter the
 *   cleanup list — daily notes persist regardless of whether a
 *   referencing block is removed within 4s).
 *
 * Why `tx.createOrGet` doesn't restore on tombstone (v4.26):  Restore
 * is domain policy. The primitive throws DeletedConflictError loudly
 * and lets the domain helper decide what fields to refresh. The
 * shared helper here is the canonical refresh policy for parseReferences
 * + Roam import.
 *
 * NOTE: `createOrRestoreTargetBlock` is helper-layer, NOT exposed on
 * the public Tx surface (per v4.31). Plugin authors writing their own
 * deterministic-id flows can import it from `@/data/targets`.
 */

import { v5 as uuidv5 } from 'uuid'
import { DeletedConflictError, type Tx, type TypeRegistrySnapshot } from '@/data/api'
import type { Repo } from '@/data/repo'
import { keyAtEnd } from './orderKey'
import { aliasesProp } from './internals/coreProperties'
import { DAILY_NOTE_TYPE, PAGE_TYPE } from './blockTypes'

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

/** Namespace for alias-seat ids. Shared with the legacy
 *  `aliasBlockId` if there was one; for v1 we anchor a new namespace
 *  here. The input format is `${workspaceId}:${alias}` so two
 *  workspaces typing the same alias get distinct seats. */
const ALIAS_NS = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'

/** Namespace for daily-note target ids. Mirrors
 *  `src/data/dailyNotes.ts` DAILY_NOTE_NS (which the server-side
 *  deterministic-seed migration also references) so date-shaped
 *  aliases compute the same id as the existing daily-notes flow. */
const DAILY_NOTE_NS = '53421e08-2f31-42f8-b73a-43830bb718f1'

/** Stable id for the **stub-block seat** that auto-materialises when
 *  nobody owns `alias` in `workspaceId` yet. NOT "the canonical id of
 *  the block named alias" — a real block claiming the alias keeps its
 *  own (random) id and lookup-first finds it. The seat id is only
 *  used by callers that resolve an unowned alias and want to either
 *  point a reference at a deterministic spot (parseReferences) or
 *  insert/restore the stub there idempotently (Roam import,
 *  ensureAliasTarget). Two clients computing this for the same
 *  `(alias, workspaceId)` get the same id, so the seats converge
 *  through PowerSync without a duplicate-block merge. */
const computeAliasSeatId = (alias: string, workspaceId: string): string =>
  uuidv5(`${workspaceId}:${alias}`, ALIAS_NS)

const computeDailyNoteId = (date: string, workspaceId: string): string =>
  uuidv5(`${workspaceId}:${date}`, DAILY_NOTE_NS)

/** Date-shaped alias detector (§7.6). Routing decision: dates go to
 *  `ensureDailyNoteTarget` (no cleanup eligibility); non-dates go to
 *  `ensureAliasTarget` (eligible for orphan cleanup if this tx
 *  inserted them). */
export const isDateAlias = (alias: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(alias)

// ──── Layer 2 — per-domain wrappers ────

/** Ensure a stub-block seat exists for `alias` in `workspaceId`. The
 *  seat is the deterministic id `computeAliasSeatId(alias, ws)` —
 *  NOT a canonical id for "the block named alias". Callers should
 *  always lookup-first (a real block claiming the alias has its own
 *  id and that's what references should resolve to); this helper is
 *  only invoked when the lookup misses, to materialise the stub the
 *  reference will point at. Inserts at workspace-root with empty
 *  content; sets `aliases` property to `[alias]` on insert/restore.
 *  Returns `{id, inserted}`. */
export const ensureAliasTarget = async (
  tx: Tx,
  repo: Repo,
  alias: string,
  workspaceId: string,
  typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries(),
): Promise<{ id: string; inserted: boolean }> =>
  createOrRestoreTargetBlock(tx, {
    id: computeAliasSeatId(alias, workspaceId),
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(),
    freshContent: '',
    onInsertedOrRestored: async (tx, id) => {
      await tx.setProperty(id, aliasesProp, [alias])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [alias]}, typeSnapshot)
    },
  })

/** Ensure a daily-note target block exists for ISO date `date` in
 *  `workspaceId`. Same shape as ensureAliasTarget — but the deterministic
 *  id is in the daily-note namespace, and parseReferences routes results
 *  to a separate list so cleanup never sees them (§7.6). */
export const ensureDailyNoteTarget = async (
  tx: Tx,
  repo: Repo,
  date: string,
  workspaceId: string,
  typeSnapshot: TypeRegistrySnapshot = repo.snapshotTypeRegistries(),
): Promise<{ id: string; inserted: boolean }> =>
  createOrRestoreTargetBlock(tx, {
    id: computeDailyNoteId(date, workspaceId),
    workspaceId,
    parentId: null,
    orderKey: keyAtEnd(),
    freshContent: '',
    onInsertedOrRestored: async (tx, id) => {
      await tx.setProperty(id, aliasesProp, [date])
      await repo.addTypeInTx(tx, id, PAGE_TYPE, {[aliasesProp.name]: [date]}, typeSnapshot)
      await repo.addTypeInTx(tx, id, DAILY_NOTE_TYPE, {}, typeSnapshot)
    },
  })

// Re-exports so tests + other callers can use the deterministic-id
// helpers without re-importing them from internal namespaces.
export { computeAliasSeatId, computeDailyNoteId }
