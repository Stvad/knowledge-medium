import type { PowerSyncDatabase } from '@powersync/web'
import type { BlockData } from '@/types'
import {
  UPSERT_BLOCK_SQL,
  blockToRowParams,
  parseBlockRow,
  parseBlockSnapshotJson,
} from '@/data/blockSchema'
import type { BlockRow } from '@/data/blockSchema'
import {
  SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,
  SELECT_ALIASES_IN_WORKSPACE_SQL,
  SELECT_ALL_BLOCK_STATES_AT_SQL,
  SELECT_BACKLINKS_FOR_BLOCK_SQL,
  SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
  SELECT_BLOCK_EVENTS_AFTER_SQL,
  SELECT_BLOCK_SQL,
  SELECT_BLOCK_STATE_AT_SQL,
  SELECT_BLOCKS_BY_CONTENT_SQL,
  SELECT_BLOCKS_BY_TYPE_SQL,
  SELECT_FIRST_CHILD_BY_CONTENT_SQL,
  SELECT_MAX_BLOCK_EVENT_SEQ_SQL,
  buildSelectBlocksByIdsSql,
  buildSelectSubtreeBlocksSql,
} from '@/data/blockQueries'
import type { BlockEventChangeRow } from '@/data/blockQueries'

export interface WriteEventContext {
  actorUserId?: string
  // 'local-ephemeral' suppresses the powersync_crud trigger so the write never
  // enters the upload queue. Used for writes in read-only workspaces — they
  // land in SQLite and the block_events log (so reads + reactive tracking work
  // normally) but never reach ps_oplog, so PowerSync's sync_local can never
  // see or clobber them. See repoInstance.ts trigger WHEN clauses.
  source: 'local' | 'system' | 'local-ephemeral'
  txId: string
}

const SELECT_BLOCK_EXISTS_SQL = `
  SELECT id FROM blocks WHERE id = ? LIMIT 1
`

const SELECT_FIRST_ROOT_BLOCK_ID_SQL = `
  SELECT id
  FROM blocks
  WHERE parent_id IS NULL
    AND workspace_id = ?
  ORDER BY create_time ASC, id ASC
  LIMIT 1
`

const DELETE_BLOCK_SQL = 'DELETE FROM blocks WHERE id = ?'

const INSERT_EVENT_CONTEXT_SQL = `
  INSERT INTO block_event_context (id, tx_id, source, actor_user_id)
  VALUES (1, ?, ?, ?)
`

const CLEAR_EVENT_CONTEXT_SQL = 'DELETE FROM block_event_context WHERE id = 1'

interface BlockEventTracker {
  onChange: () => void | Promise<void>
  onError?: (error: unknown) => void
}

export class BlockStorage {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly db: PowerSyncDatabase) {}

  async loadBlock(id: string): Promise<BlockData | undefined> {
    const row = await this.db.getOptional<BlockRow>(SELECT_BLOCK_SQL, [id])
    return row ? parseBlockRow(row) : undefined
  }

  async loadBlocksByIds(ids: string[]): Promise<Map<string, BlockData>> {
    if (!ids.length) return new Map()
    const rows = await this.db.getAll<BlockRow>(
      buildSelectBlocksByIdsSql(ids.length),
      ids,
    )
    return new Map(rows.map(row => [row.id, parseBlockRow(row)]))
  }

  async loadSubtree(rootId: string, includeRoot: boolean): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(
      buildSelectSubtreeBlocksSql(includeRoot),
      includeRoot ? [rootId] : [rootId, rootId],
    )
    return rows.map(parseBlockRow)
  }

  async findFirstRootId(workspaceId: string): Promise<string | undefined> {
    const row = await this.db.getOptional<{id: string}>(
      SELECT_FIRST_ROOT_BLOCK_ID_SQL,
      [workspaceId],
    )
    return row?.id
  }

  async existsBlock(id: string): Promise<boolean> {
    const row = await this.db.getOptional<{id: string}>(SELECT_BLOCK_EXISTS_SQL, [id])
    return Boolean(row)
  }

  async findBlockByAliasInWorkspace(workspaceId: string, alias: string): Promise<BlockData | null> {
    const row = await this.db.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
      [workspaceId, alias],
    )
    return row ? parseBlockRow(row) : null
  }

  async searchBlocksByContent(workspaceId: string, query: string, limit: number): Promise<BlockData[]> {
    if (!query) return []
    const rows = await this.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_CONTENT_SQL,
      [workspaceId, query, limit],
    )
    return rows.map(parseBlockRow)
  }

  async findBacklinks(workspaceId: string, targetId: string): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(
      SELECT_BACKLINKS_FOR_BLOCK_SQL,
      [workspaceId, targetId, targetId],
    )
    return rows.map(parseBlockRow)
  }

  async findBlocksByType(workspaceId: string, type: string): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_SQL,
      [workspaceId, type],
    )
    return rows.map(parseBlockRow)
  }

  async findFirstChildByContent(parentId: string, content: string): Promise<BlockData | null> {
    const row = await this.db.getOptional<BlockRow>(
      SELECT_FIRST_CHILD_BY_CONTENT_SQL,
      [parentId, content],
    )
    return row ? parseBlockRow(row) : null
  }

  async getAliasesInWorkspace(workspaceId: string, filter: string): Promise<string[]> {
    const rows = await this.db.getAll<{alias: string}>(
      SELECT_ALIASES_IN_WORKSPACE_SQL,
      [workspaceId, filter, filter],
    )
    return rows.map(row => row.alias)
  }

  async findAliasMatchesInWorkspace(
    workspaceId: string,
    filter: string,
    limit: number,
  ): Promise<Array<{alias: string, blockId: string, content: string}>> {
    return this.db.getAll<{alias: string, blockId: string, content: string}>(
      SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,
      [workspaceId, filter, filter, limit],
    )
  }

  async getBlockStateAt(id: string, timestamp: number): Promise<BlockData | undefined> {
    const row = await this.db.getOptional<{afterJson: string | null}>(
      SELECT_BLOCK_STATE_AT_SQL,
      [id, timestamp],
    )
    return parseBlockSnapshotJson(row?.afterJson)
  }

  async getAllBlockStatesAt(timestamp: number): Promise<BlockData[]> {
    const rows = await this.db.getAll<{afterJson: string | null}>(
      SELECT_ALL_BLOCK_STATES_AT_SQL,
      [timestamp],
    )
    return rows
      .map(row => parseBlockSnapshotJson(row.afterJson))
      .filter((snapshot): snapshot is BlockData => Boolean(snapshot))
  }

  async getMaxEventSeq(): Promise<number> {
    const row = await this.db.get<{seq: number}>(SELECT_MAX_BLOCK_EVENT_SEQ_SQL)
    return row.seq
  }

  async getEventsAfter(seq: number): Promise<BlockEventChangeRow[]> {
    return this.db.getAll<BlockEventChangeRow>(SELECT_BLOCK_EVENTS_AFTER_SQL, [seq])
  }

  enqueueUpsert(snapshot: BlockData, eventContext: WriteEventContext): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.executeWithEventContext(eventContext, (tx) =>
          tx.execute(UPSERT_BLOCK_SQL, blockToRowParams(snapshot)),
        )
      })
      .catch((error) => {
        console.error(`Failed to persist block ${snapshot.id}`, error)
      })
  }

  enqueueDelete(id: string, eventContext: WriteEventContext): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.executeWithEventContext(eventContext, (tx) =>
          tx.execute(DELETE_BLOCK_SQL, [id]),
        )
      })
      .catch((error) => {
        console.error(`Failed to delete block ${id}`, error)
      })
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  trackBlockEvents(tracker: BlockEventTracker): void {
    this.db.onChange({
      onChange: async () => {
        await tracker.onChange()
      },
      onError: tracker.onError,
    }, {
      tables: ['block_events'],
      throttleMs: 16,
    })
  }

  private async executeWithEventContext(
    eventContext: WriteEventContext,
    callback: (tx: {execute: (sql: string, params?: unknown[]) => Promise<unknown>}) => Promise<unknown>,
  ): Promise<void> {
    await this.db.writeLock(async (tx) => {
      await tx.execute(CLEAR_EVENT_CONTEXT_SQL)
      await tx.execute(
        INSERT_EVENT_CONTEXT_SQL,
        [eventContext.txId, eventContext.source, eventContext.actorUserId ?? null],
      )

      try {
        await callback(tx)
      } finally {
        await tx.execute(CLEAR_EVENT_CONTEXT_SQL)
      }
    })
  }
}
