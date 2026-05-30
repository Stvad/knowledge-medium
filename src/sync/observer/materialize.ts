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
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { decideStagingRow, type Materializability } from './reconcile.js'
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
// already gated this to a strictly-newer snapshot, so the write is never a
// no-op re-delivery.
const UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (${COLUMN_NAMES.join(', ')})
  VALUES (${PLACEHOLDERS})
  ON CONFLICT(id) DO UPDATE SET ${UPDATE_ASSIGNMENTS}
`

const DELETE_BLOCK_SQL = 'DELETE FROM blocks WHERE id = ?'

// Full pre-write row, both for the LWW gate (updated_at) and for the
// invalidation `before` snapshot the observer emits (parent-edge / plugin
// channels need the prior parent_id, content, properties, etc.).
const SELECT_BLOCK_BY_ID_SQL = `SELECT ${COLUMN_NAMES.join(', ')} FROM blocks WHERE id = ?`

const PENDING_UPLOAD_SQL = `
  SELECT 1 AS one FROM ps_crud
   WHERE json_extract(data, '$.id') = ?
     AND json_extract(data, '$.type') = 'blocks'
   LIMIT 1
`

const blockRowParams = (row: BlockRow): unknown[] =>
  COLUMN_NAMES.map(name => row[name])

/** Read-only surface both the auto-commit DB and an open `TxDb` satisfy, so
 *  the reconcile reads can run either outside the write tx (Phase 1 pre-gate)
 *  or inside it (Phase 2 authoritative re-check). */
type Reader = {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
}

/** True if PowerSync's upload queue holds an unsent local edit for this id. */
const hasPendingUpload = async (db: Reader, id: string): Promise<boolean> =>
  (await db.getOptional<{ one: number }>(PENDING_UPLOAD_SQL, [id])) !== null

const localUpdatedAt = async (db: Reader, id: string): Promise<number | null> =>
  (await db.getOptional<{ updated_at: number }>(
    'SELECT updated_at FROM blocks WHERE id = ?', [id],
  ))?.updated_at ?? null

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
}

/** The staging-table delta to process: ids whose staging row changed, and
 *  ids that left the synced set entirely. */
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

/** Tunables (batch sizing). Defaults are production values; tests override. */
export interface MaterializeOptions {
  readonly readChunkSize?: number
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
  const deferred: string[] = []
  const skippedStale: string[] = []
  const quarantined: string[] = []

  const stagingRows = await readStagingRows(db, change.upserted, readChunkSize)

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
    const action = decideStagingRow(materializability, row.updated_at, {
      localUpdatedAt: await localUpdatedAt(db, row.id),
      hasPendingUpload: await hasPendingUpload(db, row.id),
    })
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

    for (const candidate of candidates) {
      const { plaintext, stagingUpdatedAt, materializability } = candidate
      // The before-row read is also the LWW gate's local state — one read.
      const beforeRow = await tx.getOptional<BlockRow>(SELECT_BLOCK_BY_ID_SQL, [plaintext.id])
      const action = decideStagingRow(materializability, stagingUpdatedAt, {
        localUpdatedAt: beforeRow?.updated_at ?? null,
        hasPendingUpload: await hasPendingUpload(tx, plaintext.id),
      })
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

    for (const id of change.removed) {
      const beforeRow = await tx.getOptional<BlockRow>(SELECT_BLOCK_BY_ID_SQL, [id])
      await tx.execute(DELETE_BLOCK_SQL, [id])
      deleted.push(id)
      // Only a row that actually existed locally has anything to invalidate.
      if (beforeRow) snapshots.set(id, { before: parseBlockRow(beforeRow), after: null })
    }
  })

  return { snapshots, applied, deferred, skippedStale, quarantined, deleted }
}
