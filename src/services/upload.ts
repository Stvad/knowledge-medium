import { BLOCK_STORAGE_COLUMNS, type BlockRow } from '@/data/blockSchema.ts'
import type { LocalDb } from '@/data/internals/commitPipeline'
import { supabase } from '@/services/supabase.ts'

const MAX_OUTBOX_ENTRIES_PER_UPLOAD_BATCH = 10_000
const MAX_TRANSACTIONS_PER_UPLOAD_BATCH = 25
const MAX_BLOCKS_PER_LOCAL_SELECT = 500
const MAX_BLOCKS_PER_SUPABASE_UPSERT = 500
const BULK_PATCH_UPSERT_THRESHOLD = 2
const UPLOAD_RETRY_DELAY_MS = 5_000
const BLOCK_UPLOAD_COLUMNS_SQL = BLOCK_STORAGE_COLUMNS.map(column => column.name).join(', ')

export enum UploadOperation {
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
}

export interface UploadQueueEntry {
  table: string
  op: UploadOperation
  id: string
  opData?: Record<string, unknown>
  writeId: string
}

interface OutboxRow {
  id: number
  tx_id: number
  write_id: string
  data: string
}

type BlockUploadPayload = Record<string, unknown> & {id: string; write_id: string}

type CompactedBlockOperation =
  | {
      kind: 'upsert'
      id: string
      payload: BlockUploadPayload
      order: number
      writeId: string
    }
  | {
      kind: 'patch'
      id: string
      payload: Record<string, unknown>
      order: number
      writeId: string
    }
  | {
      kind: 'delete'
      id: string
      order: number
      writeId: string
    }

export interface UploadLoop {
  drainNow: () => void
  stop: () => void
}

const assertSupabase = () => {
  if (!supabase) {
    throw new Error('Supabase is not configured')
  }

  return supabase
}

const blockPayloadFromPut = (entry: UploadQueueEntry): BlockUploadPayload => ({
  ...(entry.opData ?? {}),
  id: entry.id,
  write_id: entry.writeId,
})

const normalizeLocalBlockUploadRow = (
  row: BlockRow,
  writeId: string = row.write_id ?? '',
): BlockUploadPayload => ({
  ...row,
  write_id: writeId,
  deleted: Boolean(row.deleted),
})

const compactBlockUploadEntries = (
  entries: readonly UploadQueueEntry[],
): CompactedBlockOperation[] => {
  const byId = new Map<string, CompactedBlockOperation>()

  for (const [order, entry] of entries.entries()) {
    if (entry.table !== 'blocks') {
      throw new Error(`Unsupported table in upload queue: ${entry.table}`)
    }

    if (entry.op === UploadOperation.PUT) {
      byId.set(entry.id, {
        kind: 'upsert',
        id: entry.id,
        payload: blockPayloadFromPut(entry),
        order,
        writeId: entry.writeId,
      })
      continue
    }

    if (entry.op === UploadOperation.PATCH) {
      const patch = {...(entry.opData ?? {}), write_id: entry.writeId}
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
          writeId: entry.writeId,
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
          writeId: entry.writeId,
        })
      } else {
        byId.set(entry.id, {
          kind: 'patch',
          id: entry.id,
          payload: patch,
          order,
          writeId: entry.writeId,
        })
      }
      continue
    }

    if (entry.op === UploadOperation.DELETE) {
      byId.set(entry.id, {
        kind: 'delete',
        id: entry.id,
        order,
        writeId: entry.writeId,
      })
      continue
    }

    throw new Error(`Unsupported upload operation: ${entry.op}`)
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

  console.debug('[electric-upload] PATCH', id, Object.keys(payload))
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

  console.debug('[electric-upload] DELETE', id)
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
    console.debug('[electric-upload] UPSERT batch', chunk.length)
    const {error} = await client
      .from('blocks')
      .upsert(chunk, {onConflict: 'id'})

    if (error) {
      throw error
    }
  }
}

const loadCurrentBlockUploadRows = async (
  database: LocalDb,
  ids: readonly string[],
): Promise<BlockUploadPayload[]> => {
  const rows: BlockUploadPayload[] = []

  for (const chunk of chunked(ids, MAX_BLOCKS_PER_LOCAL_SELECT)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const result = await database.getAll<BlockRow>(
      `SELECT ${BLOCK_UPLOAD_COLUMNS_SQL} FROM blocks WHERE id IN (${placeholders})`,
      chunk,
    )
    rows.push(...result.map(row => normalizeLocalBlockUploadRow(row)))
  }

  return rows
}

const shouldBulkUpsertPatches = (patches: readonly {id: string}[]) =>
  patches.length >= BULK_PATCH_UPSERT_THRESHOLD

const applyBlockPatches = async (
  database: LocalDb,
  patches: readonly {id: string; payload: Record<string, unknown>; writeId: string}[],
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
  const writeIdById = new Map(patches.map(patch => [patch.id, patch.writeId]))
  const rowsById = new Map(currentRows.map(row => [row.id, row]))
  const upserts = patches
    .map(patch => rowsById.get(patch.id))
    .filter((row): row is BlockUploadPayload => Boolean(row))
    .map(row => ({...row, write_id: writeIdById.get(row.id) ?? row.write_id}))

  console.debug('[electric-upload] PATCH backlog as UPSERT batch', upserts.length)
  await applyBlockUpserts(upserts)

  for (const patch of patches) {
    if (!rowsById.has(patch.id)) {
      await applyBlockPatch(patch.id, patch.payload)
    }
  }
}

const applyCompactedBlockOperations = async (
  database: LocalDb,
  operations: readonly CompactedBlockOperation[],
) => {
  const upserts: BlockUploadPayload[] = []
  const patches: Array<{id: string; payload: Record<string, unknown>; writeId: string}> = []
  const deletes: string[] = []

  for (const operation of operations) {
    if (operation.kind === 'upsert') {
      upserts.push(operation.payload)
    } else if (operation.kind === 'patch') {
      patches.push({id: operation.id, payload: operation.payload, writeId: operation.writeId})
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

const parseOutboxEntry = (row: OutboxRow): UploadQueueEntry => {
  const parsed = JSON.parse(row.data) as {
    op: UploadOperation
    type: string
    id: string
    data?: Record<string, unknown>
  }
  return {
    op: parsed.op,
    table: parsed.type,
    id: parsed.id,
    opData: parsed.data,
    writeId: row.write_id,
  }
}

const collectUploadBatch = async (database: LocalDb): Promise<OutboxRow[]> => {
  const transactions = await database.getAll<{tx_id: number}>(`
    SELECT tx_id
    FROM outbox
    GROUP BY tx_id
    ORDER BY MIN(id)
    LIMIT ?
  `, [MAX_TRANSACTIONS_PER_UPLOAD_BATCH])
  if (transactions.length === 0) return []

  const txIds = transactions.map(row => row.tx_id)
  const placeholders = txIds.map(() => '?').join(', ')
  return database.getAll<OutboxRow>(`
    SELECT id, tx_id, write_id, data
    FROM outbox
    WHERE tx_id IN (${placeholders})
    ORDER BY id
    LIMIT ?
  `, [...txIds, MAX_OUTBOX_ENTRIES_PER_UPLOAD_BATCH])
}

const deleteUploadedRows = async (
  database: LocalDb,
  rows: readonly OutboxRow[],
): Promise<void> => {
  for (const chunk of chunked(rows, 500)) {
    const placeholders = chunk.map(() => '?').join(', ')
    await database.execute(
      `DELETE FROM outbox WHERE id IN (${placeholders})`,
      chunk.map(row => row.id),
    )
  }
}

export const uploadData = async (database: LocalDb) => {
  while (true) {
    const rows = await collectUploadBatch(database)
    if (rows.length === 0) {
      return
    }

    const operations = compactBlockUploadEntries(rows.map(parseOutboxEntry))

    try {
      await applyCompactedBlockOperations(database, operations)
    } catch (err) {
      console.error('[electric-upload] upload failed', err)
      throw err
    }

    await deleteUploadedRows(database, rows)
  }
}

export const startUploadLoop = (database: LocalDb): UploadLoop => {
  let stopped = false
  let running = false
  let rerun = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (stopped) return
    if (running) {
      rerun = true
      return
    }
    void drain()
  }

  const drain = async () => {
    if (stopped || running) return
    running = true
    try {
      await uploadData(database)
    } catch {
      if (!stopped) {
        retryTimer = setTimeout(schedule, UPLOAD_RETRY_DELAY_MS)
      }
    } finally {
      running = false
      if (rerun) {
        rerun = false
        schedule()
      }
    }
  }

  const unsubscribe = database.onChange({onChange: schedule}, {tables: ['outbox']})
  schedule()

  return {
    drainNow: schedule,
    stop: () => {
      stopped = true
      unsubscribe()
      if (retryTimer) clearTimeout(retryTimer)
    },
  }
}

export const __compactBlockUploadEntriesForTest = compactBlockUploadEntries
export const __orderedBlockUpsertsForTest = orderedBlockUpserts
export const __normalizeLocalBlockUploadRowForTest = normalizeLocalBlockUploadRow
export const __shouldBulkUpsertPatchesForTest = shouldBulkUpsertPatches
