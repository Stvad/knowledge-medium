/**
 * In-memory model of the server the conversion talks to, each rule at the site
 * that implements it:
 *
 * - `blocks_history`'s trigger (20260522062437): an UPDATE records only the
 *   columns it changed, an INSERT the whole row, and an UPDATE that changes
 *   nothing records nothing;
 * - `apply_block_patches` (20260803000000): one transaction, absent columns
 *   kept as they are, `P0002` for a missing id;
 * - the clamp trigger's version bump: content changed or base drifted ⇒ newer;
 * - `blocks_require_ciphertext_for_e2ee` (20260529120000): an e2ee workspace
 *   only takes rows whose three content columns are all sealed.
 */

import { ENVELOPE_PREFIX } from '../../crypto/envelope.js'
import type { ConversionPhase, WorkspaceConversionRead } from '../../keys/conversionState.js'
import { SEALED_COLUMNS } from '../../transform.js'
import {
  ConversionErrorCode,
  type ConversionServer,
  type ResealPatch,
  type ServerBlockRow,
  type ServerHistoryRow,
  type ServerWorkspace,
} from '../conversionServer.js'
import { isSealedRow, isSealedValue } from '../sealing.js'

export interface FakeBlockRow extends ServerBlockRow {
  readonly user_updated_at: number
  readonly deleted: boolean
}

interface FakeHistoryRow extends ServerHistoryRow {
  readonly workspace_id: string
  readonly op: 'I' | 'U'
  readonly changed_columns: readonly string[] | null
}

class FakeServerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const VERSIONED_COLUMNS = [...SEALED_COLUMNS, 'deleted'] as const

export class FakeConversionServer implements ConversionServer {
  private rows = new Map<string, FakeBlockRow>()
  private historyRows: FakeHistoryRow[] = []
  private nextEventId = 1
  private readonly workspaces = new Map<string, ServerWorkspace>()
  private readonly phases = new Map<string, ConversionPhase>()
  /** Every port call in order, with how many rows or patches it carried. */
  readonly calls: Array<{method: keyof ConversionServer; count: number}> = []
  /** Rows per response, like PostgREST's `db-max-rows`. */
  maxRows = Infinity
  /** Runs as an `apply_block_patches` call starts; may write rows as another
   *  writer would, or throw to stand for a crash. */
  beforePatch?: (patches: readonly ResealPatch[]) => void
  /** Runs once an `apply_block_patches` call has committed. */
  afterPatch?: (patches: readonly ResealPatch[]) => void
  /** Rows the next page read returns in place of the current ones: a stale read. */
  readonly staleReads = new Map<string, FakeBlockRow>()
  /** A session that has lost its sign-in: RLS hides every row, and writes are refused. */
  signedOut = false
  /** The workspaces' owner, for the owner-only RPCs. */
  ownerUserId = 'user-1'
  /** The user this session is signed in as. */
  sessionUserId = 'user-1'
  /** How many more flips refuse with `55P03`, as when block writes are in flight. */
  writesInFlight = 0
  /** The next flip commits, then its response is lost, as on a client timeout. */
  loseNextFlipResponse = false

  /** `convert_workspace_to_e2ee`, committed: the mode, canary and phase change,
   *  no row does. */
  flip(workspaceId: string, canary: string): void {
    this.workspaces.set(workspaceId, {encryption_mode: 'e2ee', wk_canary: canary})
    this.phases.set(workspaceId, 'sealing')
  }

  /** The purge and `finish_conversion` move the phase on; null ends the conversion. */
  setPhase(workspaceId: string, phase: ConversionPhase | null): void {
    if (phase === null) this.phases.delete(workspaceId)
    else this.phases.set(workspaceId, phase)
  }

  /** What `fetchWorkspaceConversionState` reads: the workspace row with its
   *  conversion phase, in one snapshot. */
  async conversionState(workspaceId: string): Promise<WorkspaceConversionRead> {
    if (this.signedOut) return {kind: 'not-visible'}
    const workspace = this.workspaces.get(workspaceId) ?? {encryption_mode: 'none', wk_canary: null}
    return {
      kind: 'read',
      state: {
        encryptionMode: workspace.encryption_mode,
        conversionPhase: this.phases.get(workspaceId) ?? null,
        wkCanary: workspace.wk_canary,
        ownerUserId: this.ownerUserId,
      },
    }
  }

  insert(row: Pick<FakeBlockRow, 'id' | 'workspace_id'> & Partial<FakeBlockRow>): FakeBlockRow {
    const full: FakeBlockRow = {
      content: '',
      properties_json: '{}',
      references_json: '[]',
      updated_at: 1,
      user_updated_at: 1,
      deleted: false,
      ...row,
    }
    this.requireCiphertext(full)
    this.rows.set(full.id, full)
    this.historyRows.push({
      event_id: this.nextEventId++,
      block_id: full.id,
      workspace_id: full.workspace_id,
      op: 'I',
      changed_columns: null,
      before_diff: null,
      after_diff: {...full},
    })
    return full
  }

  /** Another writer's UPDATE, through the same triggers. */
  write(id: string, changes: Partial<Omit<FakeBlockRow, 'id' | 'workspace_id'>>): void {
    this.update(this.require(id), changes, undefined)
  }

  row(id: string): FakeBlockRow {
    return this.require(id)
  }

  workspaceRows(workspaceId: string): FakeBlockRow[] {
    return this.sorted().filter(row => row.workspace_id === workspaceId)
  }

  async readWorkspace(workspaceId: string): Promise<ServerWorkspace | null> {
    this.calls.push({method: 'readWorkspace', count: 1})
    if (this.signedOut) return null
    return this.workspaces.get(workspaceId) ?? {encryption_mode: 'none', wk_canary: null}
  }

  async countBlocks(workspaceId: string): Promise<number> {
    this.calls.push({method: 'countBlocks', count: 1})
    return this.visibleRows(workspaceId).length
  }

  async readBlockPage(workspaceId: string, afterId: string | null, limit: number): Promise<ServerBlockRow[]> {
    const page = this.visibleRows(workspaceId)
      .filter(row => afterId === null || row.id > afterId)
      .slice(0, Math.min(limit, this.maxRows))
      .map(row => {
        const stale = this.staleReads.get(row.id)
        this.staleReads.delete(row.id)
        return stale ?? row
      })
    this.calls.push({method: 'readBlockPage', count: page.length})
    return page
  }

  async readBlocks(workspaceId: string, ids: readonly string[]): Promise<ServerBlockRow[]> {
    const rows = this.visibleRows(workspaceId).filter(row => ids.includes(row.id))
    this.calls.push({method: 'readBlocks', count: rows.length})
    return rows
  }

  async readContentSealHistory(workspaceId: string, blockIds: readonly string[]): Promise<ServerHistoryRow[]> {
    const rows = this.historyRows.filter(row =>
      !this.signedOut &&
      row.workspace_id === workspaceId &&
      blockIds.includes(row.block_id) &&
      row.op === 'U' &&
      SEALED_COLUMNS.every(column => row.changed_columns?.includes(column)) &&
      String(row.after_diff?.content).startsWith(ENVELOPE_PREFIX))
      // The port promises no order, so the fake doesn't keep one.
      .reverse()
    this.calls.push({method: 'readContentSealHistory', count: rows.length})
    return rows
  }

  async applyBlockPatches(patches: readonly ResealPatch[]): Promise<void> {
    this.calls.push({method: 'applyBlockPatches', count: patches.length})
    if (this.signedOut) throw new FakeServerError('42501', 'anon writes to blocks are refused')
    this.beforePatch?.(patches)
    const saved = {rows: new Map(this.rows), history: [...this.historyRows], nextEventId: this.nextEventId}
    try {
      const missing = patches.filter(patch => !this.rows.has(patch.id)).map(patch => patch.id)
      if (missing.length > 0) {
        throw new FakeServerError('P0002', `apply_block_patches: missing block ids: ${missing.join(',')}`)
      }
      for (const {id, base_updated_at, ...columns} of patches) {
        this.update(this.require(id), columns, base_updated_at)
      }
    } catch (error) {
      this.rows = saved.rows
      this.historyRows = saved.history
      this.nextEventId = saved.nextEventId
      throw error
    }
    this.afterPatch?.(patches)
  }

  async readEnvelopePrefixedPage(workspaceId: string, afterId: string | null, limit: number): Promise<ServerBlockRow[]> {
    const page = this.visibleRows(workspaceId)
      .filter(row => afterId === null || row.id > afterId)
      .filter(row => SEALED_COLUMNS.every(column => row[column].startsWith(ENVELOPE_PREFIX)))
      .slice(0, Math.min(limit, this.maxRows))
    this.calls.push({method: 'readEnvelopePrefixedPage', count: page.length})
    return page
  }

  async convertWorkspaceToE2ee(workspaceId: string, canary: string): Promise<void> {
    this.calls.push({method: 'convertWorkspaceToE2ee', count: 1})
    if (this.signedOut || this.sessionUserId !== this.ownerUserId) {
      throw new FakeServerError(ConversionErrorCode.refused, 'convert_workspace_to_e2ee: only the workspace owner can convert it')
    }
    if (!isSealedValue(canary)) {
      throw new FakeServerError(ConversionErrorCode.refused, 'convert_workspace_to_e2ee: the canary is not an enc:v1: envelope')
    }
    if (this.workspaces.get(workspaceId)?.encryption_mode === 'e2ee') {
      throw new FakeServerError(ConversionErrorCode.refused, 'convert_workspace_to_e2ee: the workspace is not plaintext')
    }
    if (this.writesInFlight > 0) {
      this.writesInFlight--
      throw new FakeServerError(ConversionErrorCode.lockNotAvailable, 'convert_workspace_to_e2ee: writes are in flight; retry')
    }
    this.flip(workspaceId, canary)
    if (this.loseNextFlipResponse) {
      this.loseNextFlipResponse = false
      throw new Error('conversion: convert_workspace_to_e2ee failed: the request timed out')
    }
  }

  private update(
    old: FakeBlockRow,
    changes: Partial<Omit<FakeBlockRow, 'id' | 'workspace_id'>>,
    base: number | undefined,
  ): void {
    const next = {...old, ...changes}
    this.requireCiphertext(next)
    const drifted = base !== undefined && base !== old.updated_at
    const changed = VERSIONED_COLUMNS.some(column => next[column] !== old[column])
    const updated: FakeBlockRow = {...next, updated_at: drifted || changed ? old.updated_at + 1 : old.updated_at}
    this.rows.set(old.id, updated)
    this.recordUpdate(old, updated)
  }

  private recordUpdate(old: FakeBlockRow, updated: FakeBlockRow): void {
    const changed = (Object.keys(updated) as (keyof FakeBlockRow)[])
      .filter(column => old[column] !== updated[column])
      .sort()
    if (changed.length === 0) return
    this.historyRows.push({
      event_id: this.nextEventId++,
      block_id: old.id,
      workspace_id: old.workspace_id,
      op: 'U',
      changed_columns: changed,
      before_diff: Object.fromEntries(changed.map(column => [column, old[column]])),
      after_diff: Object.fromEntries(changed.map(column => [column, updated[column]])),
    })
  }

  private requireCiphertext(row: FakeBlockRow): void {
    if (this.workspaces.get(row.workspace_id)?.encryption_mode === 'e2ee' && !isSealedRow(row)) {
      throw new FakeServerError('23514', 'blocks in an e2ee workspace must carry a well-formed enc:v1: envelope')
    }
  }

  private visibleRows(workspaceId: string): FakeBlockRow[] {
    return this.signedOut ? [] : this.workspaceRows(workspaceId)
  }

  private require(id: string): FakeBlockRow {
    const row = this.rows.get(id)
    if (!row) throw new FakeServerError('P0002', `no block ${id}`)
    return row
  }

  private sorted(): FakeBlockRow[] {
    return [...this.rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
}
