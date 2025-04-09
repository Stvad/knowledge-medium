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
      return blockMap.values().next().value!
    }
  },
  (_, rootUrl) => rootUrl,
)

const App = () => {
  const repo = useRepo()
  const location = useLocation()
  const safeMode = Boolean(useSearchParam('safeMode'))

  const rootDocUrl = location.hash?.substring(1)
  const handle = use(getInitialBlock(repo, rootDocUrl))
  const docId = document.location.hash = handle.id

  const rootBlock = use(getRootBlock(repo.find(docId)))

  return (
    <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
      <BlockComponent blockId={docId}/>
    </BlockContextProvider>
  )
}

export default App
