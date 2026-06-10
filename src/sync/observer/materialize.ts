/**
 * Layout B observer — materialization core (design doc §9.2).
 *
 * Turns `blocks_synced` staging rows into the app-visible plaintext `blocks`
 * table. This is the data-movement heart of the observer, kept separate from
 * the change-subscription wiring (which decides *when* to run it) and the
 * invalidation relocation (which decides *who to notify* afterwards) so it can
 * be exhaustively tested against a real DB.
 *
 * For each staging row it answers, via the pure {@link decideStagingRow}:
 *
 *   - apply (decrypt)  — e2ee workspace with the WK loaded: run the content
 *     columns through {@link decodeFromWire}, write plaintext to `blocks`.
 *   - apply (copy)     — plaintext workspace: write the row through unchanged.
 *   - defer            — not materializable yet (locked/key-required e2ee, or
 *     encryption-uncertain): leave it in staging for a later drain.
 *   - skip-stale       — materializable, but a newer/pending local edit must
 *     not be clobbered; let the upload echo reconcile.
 *
 * And for ids that left the synced set (`removed`) it hard-deletes the local
 * `blocks` row (membership revoke / workspace delete / true stream-exit).
 *
 * EVERY write here leaves `tx_context.source` NULL — identical to how
 * PowerSync's own CRUD-apply path writes the tables it manages. The
 * upload-routing triggers gate on `source IS NOT NULL`, so they skip these
 * writes (no echo-upload loop), while the ungated derived-index triggers
 * (aliases / types / FTS) still fire and keep those indexes current.
 */

import {
  BLOCK_STORAGE_COLUMNS,
  parseBlockRow,
  type BlockRow,
} from '@/data/blockSchema.js'
import type { BlockData } from '@/data/api'
import { systemAuthor } from '@/data/api'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import {
  decideStagingRow,
  type Materializability,
  type ReconcileMode,
} from './reconcile.js'
import { decodeFromWire, type GetCek } from '../transform.js'

export type { Materializability } from './reconcile.js'

const COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(column => column.name)
const PLACEHOLDERS = COLUMN_NAMES.map(() => '?').join(', ')
const UPDATE_ASSIGNMENTS = COLUMN_NAMES
  .filter(name => name !== 'id')
  .map(name => `${name} = excluded.${name}`)
  .join(', ')

// ON CONFLICT DO UPDATE (not INSERT OR REPLACE): an UPDATE keeps the FTS
// rowid stable in the derived-index triggers, whereas DELETE+INSERT would
// reallocate `blocks_fts_rowids`. No WHERE-diff guard — `decideStagingRow`
// skips equal-stamp snapshots (the only no-op re-delivery), so a row that
// reaches this write always differs from the local row.
const UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (${COLUMN_NAMES.join(', ')})
  VALUES (${PLACEHOLDERS})
  ON CONFLICT(id) DO UPDATE SET ${UPDATE_ASSIGNMENTS}
`

const DELETE_BLOCK_SQL = 'DELETE FROM blocks WHERE id = ?'

// All block ids with an unsent local edit queued for upload. A pending edit
// always wins over an incoming snapshot (the echo reconciles), so the gate
// needs this set. `ps_crud.data` is the upload envelope the blocks_upload_*
// triggers write: `{op, type, id, data}`. DISTINCT ids only — an editing burst
// fans out to many crud rows for one block. Read once per pass instead of a
// per-row probe: the queue holds only local, not-yet-synced edits (tiny in
// steady state, empty during a large initial download).
const PENDING_UPLOAD_IDS_SQL = `
  SELECT DISTINCT json_extract(data, '$.id') AS id FROM ps_crud
   WHERE json_extract(data, '$.type') = 'blocks'
`

const blockRowParams = (row: BlockRow): unknown[] =>
  COLUMN_NAMES.map(name => row[name])

/** Minimal read surface both the auto-commit DB and an open write-tx (`TxDb`)
 *  satisfy, so the bulk gate reads run either outside the write tx (Phase 1
 *  pre-gate) or inside it (Phase 2 authoritative re-check). */
type RowsReader = {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/** Resolve how a workspace's rows can be materialized right now. The policy
 *  (pin lookup, WK presence, §6 quarantine) is injected; the observer core
 *  is agnostic to how that decision is reached. */
export type GetMaterializability = (
  workspaceId: string,
) => Materializability | Promise<Materializability>

export interface MaterializeDeps {
  readonly getMaterializability: GetMaterializability
  /** Workspace-key lookup, threaded to {@link decodeFromWire} for decrypt. */
  readonly getCek: GetCek
  /** The current client's user id. The gate compares a local row's
   *  `updated_by` against `systemAuthor(currentUserId)` to recognize THIS
   *  client's own pristine speculative default (which yields to the server).
   *  A `system:other` row that arrived via sync is already server truth and
   *  must not be treated as a local mint, hence the exact-current-user match. */
  readonly currentUserId: string
}

/** The staging-table delta to process: ids whose staging row changed, and ids
 *  whose staging row was deleted. A `removed` id only hard-deletes the local
 *  row if its `blocks_synced` row is actually gone — a delete whose staging row
 *  is still present is an INSERT OR REPLACE re-delivery artifact, not a
 *  stream-exit (see the Phase 2 removed loop). */
export interface StagingChange {
  readonly upserted: readonly string[]
  readonly removed: readonly string[]
}

/** Before/after pair for a row the pass changed. Sides are full `BlockData`;
 *  the slim `ChangeSnapshotSide` the invalidation rules see is a structural
 *  subset, so this map feeds `snapshotsToChangeNotification` directly. */
export interface SyncSnapshot {
  readonly before: BlockData | null
  readonly after: BlockData | null
}

/** What the pass did. `snapshots` carries the before/after for every applied
 *  (after set) and deleted (after null) row — the observer's invalidation
 *  layer consumes it; the id lists are for tests and bookkeeping. */
export interface MaterializeOutcome {
  readonly snapshots: ReadonlyMap<string, SyncSnapshot>
  /** Ids materialized into `blocks` (decrypted or copied). */
  readonly applied: readonly string[]
  /** Ids left in staging (workspace not materializable yet). */
  readonly deferred: readonly string[]
  /** Ids skipped because a newer/pending local edit wins. */
  readonly skippedStale: readonly string[]
  /** Ids whose ciphertext could not be decrypted (corrupt / tampered /
   *  well-formed-but-invalid). Left staged; deliberately do NOT wedge the
   *  drain so the rest of the batch still materializes. */
  readonly quarantined: readonly string[]
  /** Ids hard-deleted from `blocks`. */
  readonly deleted: readonly string[]
}

interface ApplyCandidate {
  readonly plaintext: BlockRow
  readonly stagingUpdatedAt: number
  readonly materializability: Exclude<Materializability, 'defer'>
}

const buildInClause = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ')

// Max ids per `WHERE id IN (...)` staging read. SQLite caps bound parameters
// (SQLITE_MAX_VARIABLE_NUMBER — 999 on older builds, 32766 since 3.32); a large
// initial sync or a long observer-down backlog can queue far more changed ids
// than that. One oversized IN read would throw before any row materialized,
// and since the queue is only consumed AFTER a successful pass, the batch would
// wedge and every retry refail. 500 stays well under the old floor.
const STAGING_READ_CHUNK = 500

/** Read staging rows for `ids` in bounded chunks so the IN-clause never exceeds
 *  SQLite's bound-parameter limit. Missing ids (already removed) are simply
 *  absent from the result. */
const readStagingRows = async (
  db: PowerSyncDb,
  ids: readonly string[],
  chunkSize: number,
): Promise<BlockRow[]> => {
  const out: BlockRow[] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const rows = await db.getAll<BlockRow>(
      `SELECT ${COLUMN_NAMES.join(', ')} FROM blocks_synced
        WHERE id IN (${buildInClause(chunk.length)})`,
      chunk,
    )
    out.push(...rows)
  }
  return out
}

/** The local gate inputs for one id: the `blocks` row's `updated_at` (the LWW
 *  stamp) and `updated_by` (the provenance discriminator). */
interface LocalGateRow {
  readonly updatedAt: number
  readonly updatedBy: string
}

/** Local gate inputs for the `ids` the app already has a `blocks` row for,
 *  keyed by id. Chunked so the IN-clause never exceeds SQLite's bound-parameter
 *  limit. Absent ids = no local row. This is the Phase-1 slim read (id +
 *  updated_at + updated_by) — Phase 2 re-derives the same fields from the full
 *  before-rows it already loads. */
const readLocalGateRows = async (
  db: RowsReader, ids: readonly string[], chunkSize: number,
): Promise<Map<string, LocalGateRow>> => {
  const out = new Map<string, LocalGateRow>()
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const rows = await db.getAll<{ id: string; updated_at: number; updated_by: string }>(
      `SELECT id, updated_at, updated_by FROM blocks WHERE id IN (${buildInClause(chunk.length)})`,
      chunk,
    )
    for (const row of rows) out.set(row.id, { updatedAt: row.updated_at, updatedBy: row.updated_by })
  }
  return out
}

/** Full pre-write `blocks` rows for `ids`, keyed by id — serves both the LWW
 *  gate's local stamp and the invalidation `before` snapshot (parent-edge /
 *  plugin channels need the prior parent_id, content, properties, etc.).
 *  Chunked like the staging read. */
const readBlocksByIds = async (
  db: RowsReader, ids: readonly string[], chunkSize: number,
): Promise<Map<string, BlockRow>> => {
  const out = new Map<string, BlockRow>()
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const rows = await db.getAll<BlockRow>(
      `SELECT ${COLUMN_NAMES.join(', ')} FROM blocks WHERE id IN (${buildInClause(chunk.length)})`,
      chunk,
    )
    for (const row of rows) out.set(row.id, row)
  }
  return out
}

/** Block ids with an unsent local edit queued for upload (a single read of the
 *  whole upload queue, not a per-row probe). */
const readPendingUploadIds = async (db: RowsReader): Promise<Set<string>> => {
  const rows = await db.getAll<{ id: string }>(PENDING_UPLOAD_IDS_SQL)
  return new Set(rows.map(row => row.id))
}

/** Subset of `ids` that still have a row in the `blocks_synced` staging table.
 *  Chunked like the other id-keyed reads. */
const readExistingStagingIds = async (
  db: RowsReader, ids: readonly string[], chunkSize: number,
): Promise<Set<string>> => {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const rows = await db.getAll<{ id: string }>(
      `SELECT id FROM blocks_synced WHERE id IN (${buildInClause(chunk.length)})`,
      chunk,
    )
    for (const row of rows) out.add(row.id)
  }
  return out
}

/** Tunables (batch sizing). Defaults are production values; tests override. */
export interface MaterializeOptions {
  readonly readChunkSize?: number
  /** Which conflict rule the gate applies (default `strict`). The one-time
   *  recovery rescan passes `healing` so pre-provenance shadows — stamped with
   *  the real user, so `strict` would protect them — still yield to the
   *  server. See {@link ReconcileMode}. */
  readonly gateMode?: ReconcileMode
}

/**
 * Process one staging-table delta: decrypt/copy materializable rows into
 * `blocks`, leave non-materializable rows staged, skip rows a local edit
 * should win, and hard-delete rows that left the synced set.
 *
 * Two phases. Phase 1 (outside the write tx) resolves materializability, runs
 * the staleness gate, and decrypts ONLY the rows that pass it — so a stale
 * (and possibly undecryptable: tampered, opened with the wrong key) ciphertext
 * we're going to skip anyway never reaches `decodeFromWire` and can't abort
 * the batch. Phase 2 (inside the write tx) re-runs the gate authoritatively
 * before writing: the two write transactions are serialized, but the Phase-1
 * reads are not in the lock, so a local edit can land in between and must
 * still win. Keeping decrypt out of the lock also keeps the write window
 * short.
 */
export const materializeStagingRows = async (
  db: PowerSyncDb,
  change: StagingChange,
  deps: MaterializeDeps,
  options: MaterializeOptions = {},
): Promise<MaterializeOutcome> => {
  const { getMaterializability, getCek } = deps
  const readChunkSize = options.readChunkSize ?? STAGING_READ_CHUNK
  const gateMode = options.gateMode ?? 'strict'
  // This client's own system author. A local row whose `updated_by` equals it
  // is a pristine speculative default we minted ourselves (yields to the
  // server); `system:<otherUser>` and real-user authors do not match.
  const ownSystemAuthor = systemAuthor(deps.currentUserId)
  const deferred: string[] = []
  const skippedStale: string[] = []
  const quarantined: string[] = []

  const stagingRows = await readStagingRows(db, change.upserted, readChunkSize)

  // Bulk-read the gate's local state for the whole batch up front, rather than
  // two awaited probes per row. On a large backlog those per-row probes — a
  // `blocks` lookup plus a `ps_crud` json_extract scan, each a serialized
  // round-trip to the SQLite worker — were the dominant cost, not the copy.
  const localGateRowById = await readLocalGateRows(
    db, stagingRows.map(row => row.id), readChunkSize,
  )
  const pendingUploadIds = await readPendingUploadIds(db)

  const materializabilityByWs = new Map<string, Materializability>()
  const resolveMaterializability = async (workspaceId: string): Promise<Materializability> => {
    const cached = materializabilityByWs.get(workspaceId)
    if (cached !== undefined) return cached
    const resolved = await getMaterializability(workspaceId)
    materializabilityByWs.set(workspaceId, resolved)
    return resolved
  }

  // ── Phase 1 (outside the write tx): decide, then decrypt only survivors. ──
  const candidates: ApplyCandidate[] = []
  for (const row of stagingRows) {
    const materializability = await resolveMaterializability(row.workspace_id)
    if (materializability === 'defer') {
      deferred.push(row.id)
      continue
    }
    const localRow = localGateRowById.get(row.id)
    const action = decideStagingRow(materializability, row.updated_at, {
      localUpdatedAt: localRow?.updatedAt ?? null,
      hasPendingUpload: pendingUploadIds.has(row.id),
      isOwnSystemMint: localRow?.updatedBy === ownSystemAuthor,
    }, gateMode)
    if (action.kind !== 'apply') {
      // Skip-stale BEFORE decrypt: a stale ciphertext never gets decoded.
      skippedStale.push(row.id)
      continue
    }
    const mode = materializability === 'decrypt' ? 'e2ee' : 'none'
    let plaintext: BlockRow
    try {
      plaintext = await decodeFromWire(row, mode, getCek)
    } catch (err) {
      // Undecryptable despite a well-formed `enc:v1:` envelope (the server can
      // only validate envelope SHAPE, so corrupt/tampered bytes or a direct
      // writer can produce this; a key race can too). Quarantine THIS row so it
      // can't wedge the whole drain — the batch continues, later valid rows
      // still materialize, and the watermark advances past it. It stays as
      // ciphertext in staging (never shown) and re-materializes if the server
      // re-uploads valid bytes or a drainWorkspace re-pass runs. Plaintext
      // copy-through never reaches here (decodeFromWire is identity for 'none').
      console.warn(`[materializeStagingRows] quarantined undecryptable block ${row.id}:`, err)
      quarantined.push(row.id)
      continue
    }
    candidates.push({ plaintext, stagingUpdatedAt: row.updated_at, materializability })
  }

  const snapshots = new Map<string, SyncSnapshot>()
  const applied: string[] = []
  const deleted: string[] = []

  if (candidates.length === 0 && change.removed.length === 0) {
    return { snapshots, applied, deferred, skippedStale, quarantined, deleted }
  }

  // ── Phase 2 (inside the write tx): authoritative re-gate, then write. ──
  await db.writeTransaction(async tx => {
    // Bracket the writes in a source-NULL tx_context so the upload triggers
    // skip them. NULL is already the resting state between local txns, but
    // set it explicitly to defend against any stale value.
    await tx.execute('UPDATE tx_context SET source = NULL WHERE id = 1')

    // Re-gate authoritatively INSIDE the lock, but bulk-read the inputs once.
    // Candidate ids are distinct (deduped upstream) so no upsert below feeds a
    // later candidate's before-row, and the NULL-source upserts never touch
    // `ps_crud` — so one up-front read of each input equals a per-row probe,
    // with far fewer round-trips. The before-rows double as the `before`
    // invalidation snapshots.
    const beforeRowById = await readBlocksByIds(
      tx, candidates.map(candidate => candidate.plaintext.id), readChunkSize,
    )
    const pendingNow = await readPendingUploadIds(tx)

    for (const candidate of candidates) {
      const { plaintext, stagingUpdatedAt, materializability } = candidate
      const beforeRow = beforeRowById.get(plaintext.id) ?? null
      const action = decideStagingRow(materializability, stagingUpdatedAt, {
        localUpdatedAt: beforeRow?.updated_at ?? null,
        hasPendingUpload: pendingNow.has(plaintext.id),
        isOwnSystemMint: beforeRow?.updated_by === ownSystemAuthor,
      }, gateMode)
      if (action.kind === 'apply') {
        await tx.execute(UPSERT_BLOCK_SQL, blockRowParams(plaintext))
        applied.push(plaintext.id)
        snapshots.set(plaintext.id, {
          before: beforeRow ? parseBlockRow(beforeRow) : null,
          after: parseBlockRow(plaintext),
        })
      } else {
        // A local edit landed between Phase 1 and the lock — it wins.
        skippedStale.push(plaintext.id)
      }
    }

    const removedBeforeById = await readBlocksByIds(tx, change.removed, readChunkSize)
    // A 'delete' whose staging row still exists is an INSERT OR REPLACE
    // re-delivery artifact, not a stream-exit: SQLite's REPLACE fires the
    // staging delete trigger then the insert trigger, enqueuing delete-then-
    // upsert for one row. Drained in seq windows, that pair can split so the
    // delete arrives alone here. Deleting the local row then would be wrong —
    // the trailing upsert is gated (skip-stale on a pending local edit / newer
    // local stamp), so the block would vanish and an unsent edit be lost. Only
    // hard-delete ids whose staging row is truly gone; the upsert (this window
    // or a later one) reconciles the rest through the gate.
    const removedStillStaged = await readExistingStagingIds(tx, change.removed, readChunkSize)
    for (const id of change.removed) {
      if (removedStillStaged.has(id)) continue
      await tx.execute(DELETE_BLOCK_SQL, [id])
      deleted.push(id)
      // Only a row that actually existed locally has anything to invalidate.
      const beforeRow = removedBeforeById.get(id)
      if (beforeRow) snapshots.set(id, { before: parseBlockRow(beforeRow), after: null })
    }
  })

  return { snapshots, applied, deferred, skippedStale, quarantined, deleted }
}
