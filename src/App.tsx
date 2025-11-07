import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { use, useEffect, useState } from 'react'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useLocation, useSearchParam } from 'react-use'
import { importState } from '@/utils/state.ts'
import { getExampleBlocks } from '@/initData.ts'
import { Repo } from '@/data/repo'
import { memoize } from 'lodash'
import { FEATURE_SQLITE_BACKEND } from '@/config/featureFlags'
import { useSqliteRepo } from '@/context/sqliteRepo'
import { useSqliteBlock } from '@/hooks/sqliteBlock'

const getInitialBlock = memoize(
  async (repo: Repo, rootDocUrl: string | undefined): Promise<Block> => {
    if (isValidAutomergeUrl(rootDocUrl)) {
      return repo.find(rootDocUrl)
    } else {
      const blockMap = await importState({blocks: getExampleBlocks()}, repo)
      const block = blockMap.values().next().value!
      document.location.hash = block.id
      return block
    }
  },
  (_, rootUrl) => rootUrl,
)

const SqliteBlockTree = ({ blockId, depth = 0 }: { blockId: string; depth?: number }) => {
  const { data } = useSqliteBlock(blockId)

  if (!data) return null

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className="font-medium text-slate-200 mb-1">{data.content || '(empty block)'}</div>
      {data.childIds.map((childId) => (
        <SqliteBlockTree key={childId} blockId={childId} depth={depth + 1} />
      ))}
    </div>
  )
}

const SqliteApp = () => {
  const repo = useSqliteRepo()
  const [rootIds, setRootIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      await repo.ensureSeedData()
      const roots = await repo.listRootBlocks()
      if (!cancelled) {
        setRootIds(roots.map((block) => block.id))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [repo])

  if (rootIds.length === 0) {
    return <div className="p-4 text-slate-400">Loading SQLite blocks…</div>
  }

  return (
    <div className="p-4 space-y-4">
      {rootIds.map((blockId) => (
        <SqliteBlockTree key={blockId} blockId={blockId} />
      ))}
    </div>
  )
}

const App = () => {
  if (FEATURE_SQLITE_BACKEND) {
    return <SqliteApp />
  }
  const repo = useRepo()
  const location = useLocation()
  const safeMode = Boolean(useSearchParam('safeMode'))

  const initialDocId = location.hash?.substring(1)
  const handle = use(getInitialBlock(repo, initialDocId))
  const rootBlock = use(getRootBlock(repo.find(handle.id)))

  return (
    <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
      <BlockComponent blockId={handle.id}/>
    </BlockContextProvider>
  )
}

export default App
