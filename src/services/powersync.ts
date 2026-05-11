import {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  UpdateType,
  type CrudTransaction,
} from '@powersync/common'
import { BLOCK_STORAGE_COLUMNS, type BlockRow } from '@/data/blockSchema.ts'
import { supabase, hasSupabaseAuthConfig } from '@/services/supabase.ts'

const powerSyncUrl = import.meta.env.VITE_POWERSYNC_URL?.trim()

const MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH = 10_000
const MAX_TRANSACTIONS_PER_UPLOAD_BATCH = 25
const MAX_BLOCKS_PER_LOCAL_SELECT = 500
const MAX_BLOCKS_PER_SUPABASE_UPSERT = 500
const BULK_PATCH_UPSERT_THRESHOLD = 2
const BLOCK_UPLOAD_COLUMNS_SQL = BLOCK_STORAGE_COLUMNS.map(column => column.name).join(', ')

export const hasPowerSyncServiceConfig = Boolean(powerSyncUrl)
export const hasRemoteSyncConfig = hasSupabaseAuthConfig && hasPowerSyncServiceConfig

type BlockUploadPayload = Record<string, unknown> & {id: string}

type CompactedBlockOperation =
  | {
      kind: 'upsert'
      id: string
      payload: BlockUploadPayload
      order: number
    }
  | {
      kind: 'patch'
      id: string
      payload: Record<string, unknown>
      order: number
    }
  | {
      kind: 'delete'
      id: string
      order: number
    }

const assertSupabase = () => {
  if (!supabase) {
    throw new Error('Supabase is not configured')
  }

  return supabase
}

const blockPayloadFromPut = (entry: CrudEntry): BlockUploadPayload => ({
  ...(entry.opData ?? {}),
  id: entry.id,
})

const normalizeLocalBlockUploadRow = (row: BlockRow): BlockUploadPayload => ({
  ...row,
  deleted: Boolean(row.deleted),
})

const compactBlockCrudEntries = (entries: readonly CrudEntry[]): CompactedBlockOperation[] => {
  const byId = new Map<string, CompactedBlockOperation>()

  for (const [order, entry] of entries.entries()) {
    if (entry.table !== 'blocks') {
      throw new Error(`Unsupported table in upload queue: ${entry.table}`)
    }

    if (entry.op === UpdateType.PUT) {
      byId.set(entry.id, {
        kind: 'upsert',
        id: entry.id,
        payload: blockPayloadFromPut(entry),
        order,
      })
      continue
    }

    if (entry.op === UpdateType.PATCH) {
      const patch = entry.opData ?? {}
      const existing = byId.get(entry.id)
      if (existing?.kind === 'upsert') {
        byId.set(entry.id, {
          kind: 'upsert',
          id: existing.id,
          payload: {
            ...existing.payload,
            ...patch,
          },
          order: existing.order,
        })
      } else if (existing?.kind === 'patch') {
        byId.set(entry.id, {
          kind: 'patch',
          id: existing.id,
          payload: {
            ...existing.payload,
            ...patch,
          },
          order: existing.order,
        })
      } else {
        byId.set(entry.id, {
          kind: 'patch',
          id: entry.id,
          payload: patch,
          order,
        })
      }
      continue
    }

    if (entry.op === UpdateType.DELETE) {
      byId.set(entry.id, {
        kind: 'delete',
        id: entry.id,
        order,
      })
      continue
    }

    throw new Error(`Unsupported CRUD operation: ${entry.op}`)
  }

  return [...byId.values()].sort((left, right) => left.order - right.order)
}

const orderedBlockUpserts = (rows: readonly BlockUploadPayload[]): BlockUploadPayload[] => {
  const byId = new Map(rows.map(row => [row.id, row]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const ordered: BlockUploadPayload[] = []

  const visit = (row: BlockUploadPayload) => {
    const current = state.get(row.id)
    if (current === 'visited') return
    if (current === 'visiting') return

    state.set(row.id, 'visiting')
    const parentId = typeof row.parent_id === 'string' ? row.parent_id : null
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent) visit(parent)
    state.set(row.id, 'visited')
    ordered.push(row)
  }

  for (const row of rows) visit(row)
  return ordered
}

const chunked = <T,>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

const applyBlockPatch = async (id: string, payload: Record<string, unknown>) => {
  const client = assertSupabase()

  console.debug('[powersync] PATCH', id, Object.keys(payload))
  const {error} = await client
    .from('blocks')
    .update(payload)
    .eq('id', id)

  if (error) {
    throw error
  }
}

const applyBlockDelete = async (id: string) => {
  const client = assertSupabase()

  console.debug('[powersync] DELETE', id)
  const {error} = await client
    .from('blocks')
    .delete()
    .eq('id', id)

  if (error) {
    throw error
  }
}

const applyBlockUpserts = async (rows: readonly BlockUploadPayload[]) => {
  if (rows.length === 0) return
  const client = assertSupabase()

  for (const chunk of chunked(orderedBlockUpserts(rows), MAX_BLOCKS_PER_SUPABASE_UPSERT)) {
    console.debug('[powersync] UPSERT batch', chunk.length)
    const {error} = await client
      .from('blocks')
      .upsert(chunk, {onConflict: 'id'})

    if (error) {
      throw error
    }
  }
}

const loadCurrentBlockUploadRows = async (
  database: AbstractPowerSyncDatabase,
  ids: readonly string[],
): Promise<BlockUploadPayload[]> => {
  const rows: BlockUploadPayload[] = []

  for (const chunk of chunked(ids, MAX_BLOCKS_PER_LOCAL_SELECT)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const result = await database.getAll<BlockRow>(
      `SELECT ${BLOCK_UPLOAD_COLUMNS_SQL} FROM blocks WHERE id IN (${placeholders})`,
      chunk,
    )
    rows.push(...result.map(normalizeLocalBlockUploadRow))
  }

  return rows
}

const shouldBulkUpsertPatches = (patches: readonly {id: string}[]) =>
  patches.length >= BULK_PATCH_UPSERT_THRESHOLD

const applyBlockPatches = async (
  database: AbstractPowerSyncDatabase,
  patches: readonly {id: string; payload: Record<string, unknown>}[],
) => {
  if (patches.length === 0) return

  if (!shouldBulkUpsertPatches(patches)) {
    await applyBlockPatch(patches[0]!.id, patches[0]!.payload)
    return
  }

  const currentRows = await loadCurrentBlockUploadRows(
    database,
    patches.map(patch => patch.id),
  )
  const rowsById = new Map(currentRows.map(row => [row.id, row]))
  const upserts = patches
    .map(patch => rowsById.get(patch.id))
    .filter((row): row is BlockUploadPayload => Boolean(row))

  console.debug('[powersync] PATCH backlog as UPSERT batch', upserts.length)
  await applyBlockUpserts(upserts)

  for (const patch of patches) {
    if (!rowsById.has(patch.id)) {
      await applyBlockPatch(patch.id, patch.payload)
    }
  }
}

const applyCompactedBlockOperations = async (
  database: AbstractPowerSyncDatabase,
  operations: readonly CompactedBlockOperation[],
) => {
  const upserts: BlockUploadPayload[] = []
  const patches: Array<{id: string; payload: Record<string, unknown>}> = []
  const deletes: string[] = []

  for (const operation of operations) {
    if (operation.kind === 'upsert') {
      upserts.push(operation.payload)
    } else if (operation.kind === 'patch') {
      patches.push({id: operation.id, payload: operation.payload})
    } else {
      deletes.push(operation.id)
    }
  }

  await applyBlockUpserts(upserts)

  await applyBlockPatches(database, patches)

  for (const id of deletes) {
    await applyBlockDelete(id)
  }
}

const collectUploadBatch = async (
  database: AbstractPowerSyncDatabase,
): Promise<CrudTransaction[]> => {
  const transactions: CrudTransaction[] = []
  const iterator = database.getCrudTransactions()[Symbol.asyncIterator]()
  let entryCount = 0

  while (
    transactions.length < MAX_TRANSACTIONS_PER_UPLOAD_BATCH &&
    (transactions.length === 0 || entryCount < MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH)
  ) {
    const next = await iterator.next()
    if (next.done || !next.value) break
    transactions.push(next.value)
    entryCount += next.value.crud.length
  }

  return transactions
}

const uploadTransactions = async (
  database: AbstractPowerSyncDatabase,
  transactions: readonly CrudTransaction[],
) => {
  const entries = transactions.flatMap(transaction => transaction.crud)
  const operations = compactBlockCrudEntries(entries)

  try {
    await applyCompactedBlockOperations(database, operations)
  } catch (err) {
    // Surface upload errors loudly — silent failures here look like
    // "sync isn't working" with no explanation in the UI.
    console.error('[powersync] upload failed', err)
    throw err
  }

  await transactions[transactions.length - 1]?.complete()
}

const uploadData = async (database: AbstractPowerSyncDatabase) => {
  while (true) {
    const transactions = await collectUploadBatch(database)
    if (transactions.length === 0) {
      return
    }

    await uploadTransactions(database, transactions)
  }
}

export const createPowerSyncConnector = (): PowerSyncBackendConnector => ({
  fetchCredentials: async () => {
    const client = assertSupabase()
    const {data, error} = await client.auth.getSession()

    if (error) {
      throw error
    }

    const accessToken = data.session?.access_token
    if (!accessToken || !powerSyncUrl) {
      return null
    }

    return {
      endpoint: powerSyncUrl,
      token: accessToken,
      expiresAt: data.session?.expires_at
        ? new Date(data.session.expires_at * 1000)
        : undefined,
    }
  },
  uploadData,
})

export const __compactBlockCrudEntriesForTest = compactBlockCrudEntries
export const __orderedBlockUpsertsForTest = orderedBlockUpserts
export const __normalizeLocalBlockUploadRowForTest = normalizeLocalBlockUploadRow
export const __shouldBulkUpsertPatchesForTest = shouldBulkUpsertPatches
