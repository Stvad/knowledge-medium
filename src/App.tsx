import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { use } from 'react'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useLocation, useSearchParam } from 'react-use'
import { importState } from '@/utils/state.ts'
import { getExampleBlocks } from '@/initData.ts'
import { Repo } from '@/data/repo'
import { memoize } from 'lodash'

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
