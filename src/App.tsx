import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { use } from 'react'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useLocation, useSearchParam } from 'react-use'
import { getExampleBlocks } from '@/initData.ts'
import { Repo } from '@/data/repo'
import { memoize } from 'lodash'
import { importState } from '@/utils/state.ts'
import { hasRemoteSyncConfig } from '@/services/powersync.ts'

const waitForInitialRemoteSync = async (repo: Repo, timeoutMs: number) => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    await repo.db.waitForFirstSync(controller.signal)
  } finally {
    window.clearTimeout(timeoutId)
  }
}

const getInitialBlock = memoize(
  async (repo: Repo, rootDocId: string | undefined, useRemoteSync: boolean): Promise<Block> => {
    if (rootDocId && await repo.exists(rootDocId)) {
      return repo.find(rootDocId)
    }

    let rootId = await repo.findFirstRootBlockId()

    if (!rootId && useRemoteSync) {
      await waitForInitialRemoteSync(repo, 5000)
      rootId = await repo.findFirstRootBlockId()
    }

    if (rootId) {
      if (document.location.hash !== `#${rootId}`) {
        document.location.hash = rootId
      }
      return repo.find(rootId)
    }

    if (useRemoteSync) {
      throw new Error('No root block was found after remote sync. Run the Supabase migration seed and verify the PowerSync stream for public.blocks.')
    }

    const blockMap = await importState({blocks: getExampleBlocks()}, repo)
    await repo.flush()
    const block = blockMap.values().next().value!
    document.location.hash = block.id
    return block
  },
  (repo, rootDocId, useRemoteSync) =>
    `${repo.instanceId}:${rootDocId ?? '__default__'}:${useRemoteSync ? 'remote' : 'local'}`,
)

const App = () => {
  const repo = useRepo()
  const location = useLocation()
  const safeMode = Boolean(useSearchParam('safeMode'))

  const initialDocId = location.hash?.substring(1)
  const handle = use(getInitialBlock(repo, initialDocId, hasRemoteSyncConfig))
  const rootBlock = use(getRootBlock(repo.find(handle.id)))

  return (
    <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
      <BlockComponent blockId={handle.id}/>
    </BlockContextProvider>
  )
}

export default App
