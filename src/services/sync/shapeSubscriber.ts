import {
  ShapeStream,
  isChangeMessage,
  isControlMessage,
  type ChangeMessage,
  type Message,
  type Row,
} from '@electric-sql/client'
import {
  BLOCK_STORAGE_COLUMNS,
  DELETE_BLOCK_SQL,
  UPSERT_BLOCK_SQL,
  type BlockRow,
} from '@/data/blockSchema'
import type { LocalDb } from '@/data/internals/commitPipeline'
import type { TxDb } from '@/data/internals/txEngine'
import {
  DELETE_WORKSPACE_MEMBER_SQL,
  DELETE_WORKSPACE_SQL,
  UPSERT_WORKSPACE_MEMBER_SQL,
  UPSERT_WORKSPACE_SQL,
  WORKSPACE_COLUMNS,
  WORKSPACE_MEMBER_COLUMNS,
  type WorkspaceMemberRow,
  type WorkspaceRow,
} from '@/data/workspaceSchema'
import {
  electricShapeUrl,
  getElectricAuthHeader,
  type ElectricShapeName,
} from '@/services/electric'
import { updateElectricSyncState } from './electricSyncState'

type ShapeTable = ElectricShapeName

export interface ShapeSubscriber {
  stop: () => void
}

const toNumber = (value: unknown, columnName: string): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  throw new Error(`Expected numeric value for ${columnName}`)
}

const toStringValue = (value: unknown, columnName: string): string => {
  if (typeof value === 'string') return value
  throw new Error(`Expected string value for ${columnName}`)
}

const toNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  throw new Error('Expected nullable string value')
}

const toDeletedFlag = (value: unknown): 0 | 1 => {
  if (value === true || value === 1) return 1
  if (value === false || value === 0) return 0
  throw new Error('Expected boolean deleted value')
}

const mergedShapeValue = (
  message: ChangeMessage<Row>,
  existing: object | null,
): Record<string, unknown> => ({
  ...(existing ? existing as Record<string, unknown> : {}),
  ...message.value,
})

const valueByColumns = (
  columns: readonly {name: string}[],
  row: object,
): unknown[] => {
  const record = row as Record<string, unknown>
  return columns.map(column => record[column.name])
}

const hasPendingWriteId = async (tx: TxDb, writeId: string): Promise<boolean> => {
  const row = await tx.getOptional<{id: number}>(
    'SELECT id FROM outbox WHERE write_id = ? LIMIT 1',
    [writeId],
  )
  return row !== null
}

const applyBlockChange = async (
  tx: TxDb,
  message: ChangeMessage<Row>,
): Promise<void> => {
  const id = toStringValue(message.value.id, 'blocks.id')
  if (message.headers.operation === 'delete') {
    await tx.execute(DELETE_BLOCK_SQL, [id])
    return
  }

  const writeId = toNullableString(message.value.write_id)
  if (writeId && await hasPendingWriteId(tx, writeId)) {
    return
  }

  const existing = await tx.getOptional<BlockRow>(
    `SELECT ${BLOCK_STORAGE_COLUMNS.map(column => column.name).join(', ')}
     FROM blocks
     WHERE id = ?`,
    [id],
  )
  const row = mergedShapeValue(message, existing)
  const normalized: BlockRow = {
    id,
    workspace_id: toStringValue(row.workspace_id, 'blocks.workspace_id'),
    parent_id: toNullableString(row.parent_id),
    order_key: toStringValue(row.order_key, 'blocks.order_key'),
    content: toStringValue(row.content, 'blocks.content'),
    properties_json: toStringValue(row.properties_json, 'blocks.properties_json'),
    references_json: toStringValue(row.references_json, 'blocks.references_json'),
    created_at: toNumber(row.created_at, 'blocks.created_at'),
    updated_at: toNumber(row.updated_at, 'blocks.updated_at'),
    created_by: toStringValue(row.created_by, 'blocks.created_by'),
    updated_by: toStringValue(row.updated_by, 'blocks.updated_by'),
    write_id: toNullableString(row.write_id),
    deleted: toDeletedFlag(row.deleted),
  }

  await tx.execute(UPSERT_BLOCK_SQL, valueByColumns(BLOCK_STORAGE_COLUMNS, normalized))
}

const applyWorkspaceChange = async (
  tx: TxDb,
  message: ChangeMessage<Row>,
): Promise<void> => {
  const id = toStringValue(message.value.id, 'workspaces.id')
  if (message.headers.operation === 'delete') {
    await tx.execute(DELETE_WORKSPACE_SQL, [id])
    return
  }

  const existing = await tx.getOptional<WorkspaceRow>(
    `SELECT ${WORKSPACE_COLUMNS.map(column => column.name).join(', ')}
     FROM workspaces
     WHERE id = ?`,
    [id],
  )
  const row = mergedShapeValue(message, existing)
  const normalized: WorkspaceRow = {
    id,
    name: toStringValue(row.name, 'workspaces.name'),
    owner_user_id: toStringValue(row.owner_user_id, 'workspaces.owner_user_id'),
    create_time: toNumber(row.create_time, 'workspaces.create_time'),
    update_time: toNumber(row.update_time, 'workspaces.update_time'),
  }

  await tx.execute(UPSERT_WORKSPACE_SQL, valueByColumns(WORKSPACE_COLUMNS, normalized))
}

const applyWorkspaceMemberChange = async (
  tx: TxDb,
  message: ChangeMessage<Row>,
): Promise<void> => {
  const id = toStringValue(message.value.id, 'workspace_members.id')
  if (message.headers.operation === 'delete') {
    await tx.execute(DELETE_WORKSPACE_MEMBER_SQL, [id])
    return
  }

  const existing = await tx.getOptional<WorkspaceMemberRow>(
    `SELECT ${WORKSPACE_MEMBER_COLUMNS.map(column => column.name).join(', ')}
     FROM workspace_members
     WHERE id = ?`,
    [id],
  )
  const row = mergedShapeValue(message, existing)
  const normalized: WorkspaceMemberRow = {
    id,
    workspace_id: toStringValue(row.workspace_id, 'workspace_members.workspace_id'),
    user_id: toStringValue(row.user_id, 'workspace_members.user_id'),
    role: toStringValue(row.role, 'workspace_members.role'),
    create_time: toNumber(row.create_time, 'workspace_members.create_time'),
  }

  await tx.execute(UPSERT_WORKSPACE_MEMBER_SQL, valueByColumns(WORKSPACE_MEMBER_COLUMNS, normalized))
}

const applyChange = async (
  table: ShapeTable,
  tx: TxDb,
  message: ChangeMessage<Row>,
): Promise<void> => {
  if (table === 'blocks') {
    await applyBlockChange(tx, message)
  } else if (table === 'workspaces') {
    await applyWorkspaceChange(tx, message)
  } else {
    await applyWorkspaceMemberChange(tx, message)
  }
}

const applyMessages = async (
  userId: string,
  database: LocalDb,
  table: ShapeTable,
  messages: Message<Row>[],
): Promise<void> => {
  const changes = messages.filter(isChangeMessage)
  if (changes.length > 0) {
    await database.writeTransaction(async tx => {
      for (const message of changes) {
        await applyChange(table, tx, message)
      }
    })
  }

  if (messages.some(message =>
    isControlMessage(message) && message.headers.control === 'up-to-date'
  )) {
    updateElectricSyncState(userId, {
      connected: true,
      connecting: false,
      downloading: false,
      hasSynced: true,
      errorMessage: null,
      lastSyncedAt: new Date(),
    })
  }
}

export const startShapeSubscriber = (
  userId: string,
  database: LocalDb,
): ShapeSubscriber => {
  const abortController = new AbortController()
  const unsubscribers: Array<() => void> = []

  updateElectricSyncState(userId, {
    connected: false,
    connecting: true,
    downloading: true,
    errorMessage: null,
  })

  const startStream = (table: ShapeTable) => {
    const stream = new ShapeStream<Row>({
      url: electricShapeUrl(table),
      signal: abortController.signal,
      params: {
        replica: 'full',
      },
      headers: {
        Authorization: async () => await getElectricAuthHeader() ?? '',
      },
      onError: (error) => {
        updateElectricSyncState(userId, {
          connected: false,
          connecting: true,
          downloading: true,
          errorMessage: error.message,
        })
        return {}
      },
    })

    unsubscribers.push(stream.subscribe(
      messages => applyMessages(userId, database, table, messages),
      error => updateElectricSyncState(userId, {
        connected: false,
        connecting: true,
        errorMessage: error.message,
      }),
    ))
  }

  startStream('workspaces')
  startStream('workspace_members')
  startStream('blocks')

  return {
    stop: () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      abortController.abort()
      updateElectricSyncState(userId, {
        connected: false,
        connecting: false,
        downloading: false,
      })
    },
  }
}
