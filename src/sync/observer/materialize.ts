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
  type BlockRow,
} from '@/data/blockSchema.js'
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

const blockRowParams = (row: BlockRow): unknown[] =>
  COLUMN_NAMES.map(name => row[name])

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

/** What the pass did, per id. Used by tests and (later) by the invalidation
 *  layer, which needs the applied/deleted plaintext rows to notify on. */
export interface MaterializeOutcome {
  /** Decoded plaintext rows written to `blocks`. */
  readonly applied: readonly BlockRow[]
  /** Ids left in staging (workspace not materializable yet). */
  readonly deferred: readonly string[]
  /** Ids skipped because a newer/pending local edit wins. */
  readonly skippedStale: readonly string[]
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

/**
 * Process one staging-table delta: decrypt/copy materializable rows into
 * `blocks`, leave non-materializable rows staged, skip rows a local edit
 * should win, and hard-delete rows that left the synced set.
 *
 * Decryption (CPU/async) happens BEFORE the write transaction so the write
 * lock is held only for the brief reconcile-and-write window. The local/remote
 * merge read (`ps_crud` + `updated_at`) happens INSIDE the transaction so it's
 * consistent with the write.
 */
export const materializeStagingRows = async (
  db: PowerSyncDb,
  change: StagingChange,
  deps: MaterializeDeps,
): Promise<MaterializeOutcome> => {
  const { getMaterializability, getCek } = deps
  const deferred: string[] = []

  // ── Read the staged rows and resolve + decode the materializable ones,
  //    all outside the write transaction. ──
  const stagingRows = change.upserted.length === 0
    ? []
    : await db.getAll<BlockRow>(
        `SELECT ${COLUMN_NAMES.join(', ')} FROM blocks_synced
          WHERE id IN (${buildInClause(change.upserted.length)})`,
        [...change.upserted],
      )

  const materializabilityByWs = new Map<string, Materializability>()
  const resolveMaterializability = async (workspaceId: string): Promise<Materializability> => {
    const cached = materializabilityByWs.get(workspaceId)
    if (cached !== undefined) return cached
    const resolved = await getMaterializability(workspaceId)
    materializabilityByWs.set(workspaceId, resolved)
    return resolved
  }

  const candidates: ApplyCandidate[] = []
  for (const row of stagingRows) {
    const materializability = await resolveMaterializability(row.workspace_id)
    if (materializability === 'defer') {
      deferred.push(row.id)
      continue
    }
    const mode = materializability === 'decrypt' ? 'e2ee' : 'none'
    const plaintext = await decodeFromWire(row, mode, getCek)
    candidates.push({ plaintext, stagingUpdatedAt: row.updated_at, materializability })
  }

  const applied: BlockRow[] = []
  const skippedStale: string[] = []
  const deleted: string[] = []

  if (candidates.length === 0 && change.removed.length === 0) {
    return { applied, deferred, skippedStale, deleted }
  }

  await db.writeTransaction(async tx => {
    // Bracket the writes in a source-NULL tx_context so the upload triggers
    // skip them. NULL is already the resting state between local txns, but
    // set it explicitly to defend against any stale value.
    await tx.execute('UPDATE tx_context SET source = NULL WHERE id = 1')

    for (const candidate of candidates) {
      const { plaintext, stagingUpdatedAt, materializability } = candidate
      const localRow = await tx.getOptional<{ updated_at: number }>(
        'SELECT updated_at FROM blocks WHERE id = ?',
        [plaintext.id],
      )
      const pending = await tx.getOptional<{ one: number }>(
        `SELECT 1 AS one FROM ps_crud
          WHERE json_extract(data, '$.id') = ?
            AND json_extract(data, '$.type') = 'blocks'
          LIMIT 1`,
        [plaintext.id],
      )
      const action = decideStagingRow(materializability, stagingUpdatedAt, {
        localUpdatedAt: localRow?.updated_at ?? null,
        hasPendingUpload: pending !== null,
      })
      if (action.kind === 'apply') {
        await tx.execute(UPSERT_BLOCK_SQL, blockRowParams(plaintext))
        applied.push(plaintext)
      } else {
        // 'skip-stale' (defer was filtered out before decode).
        skippedStale.push(plaintext.id)
      }
    }

    for (const id of change.removed) {
      await tx.execute(DELETE_BLOCK_SQL, [id])
      deleted.push(id)
    }
  })

  return { applied, deferred, skippedStale, deleted }
}
