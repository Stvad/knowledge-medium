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

const getInitialBlock = memoize(
  async (repo: Repo, rootDocId: string | undefined): Promise<Block> => {
    if (rootDocId && await repo.exists(rootDocId)) {
      return repo.find(rootDocId)
    }

    const blockMap = await importState({blocks: getExampleBlocks()}, repo)
    await repo.flush()
    const block = blockMap.values().next().value!
    document.location.hash = block.id
    return block
  },
  (_, rootDocId) => rootDocId ?? '__default__',
)

const App = () => {
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
