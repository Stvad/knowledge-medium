import { useEffect, useMemo, useState } from 'react'
import { useSqliteRepo } from '@/context/sqliteRepo'
import { useStorageEngine } from '@/context/storage'
import type { BlockData } from '@/types'
import type { SqliteBlock } from '@/data/sqliteBlock'

interface SqliteBlockState {
  block: SqliteBlock
  data: BlockData | undefined
}

export function useSqliteBlock(blockId: string): SqliteBlockState {
  const repo = useSqliteRepo()
  const { engine } = useStorageEngine()
  const block = useMemo(() => repo.find(blockId), [repo, blockId])
  const [data, setData] = useState<BlockData | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    const refresh = async () => {
      const doc = await repo.loadBlockData(blockId)
      if (!disposed) setData(doc)
    }

    const setup = async () => {
      if (!engine) {
        await refresh()
        return
      }

      const handle = await engine.liveQuery(
        'SELECT id FROM blocks WHERE workspace_id = ? AND id = ?',
        [repo.workspaceId, blockId],
        (row) => row
      )

      unsubscribe = handle.subscribe(() => {
        void refresh()
      })

      await refresh()

      return () => {
        handle.dispose()
      }
    }

    let disposeHandle: (() => void) | undefined
    setup().then((dispose) => {
      disposeHandle = dispose
    })

    return () => {
      disposed = true
      unsubscribe?.()
      disposeHandle?.()
    }
  }, [engine, repo, blockId])

  return { block, data }
}
