import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { use, useEffect } from 'react'
import { getUIStateBlock } from '@/data/globalState.ts'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useLocation, useSearchParam } from 'react-use'
import { importState } from '@/utils/state.ts'
import { getExampleBlocks } from '@/initData.ts'
import { Repo } from '@/data/repo'
import { memoize } from 'lodash'
import { useUser } from '@/components/Login.tsx'

const getInitialBlock = memoize(async (repo: Repo, rootDocUrl: string | undefined): Promise<Block> => {
  if (isValidAutomergeUrl(rootDocUrl)) {
    return repo.find(rootDocUrl)
  } else {
    const blockMap = await importState({blocks: getExampleBlocks()}, repo)
    return blockMap.values().next().value!
  }
}, (_, rootUrl) => rootUrl)

const updateLoadTimes = memoize((uiStateBlock: Block) => {
  uiStateBlock.change(doc => {
    doc.properties.previousLoadTime = doc.properties.currentLoadTime ? doc.properties.currentLoadTime : 0
    doc.properties.currentLoadTime = Date.now()
  })
}, () => true)

const useInitUIState = (rootBlock: Block, topLevelBlockId: string) => {
  const repo = useRepo()
  const user = useUser()

  const uiStateBlock = use(getUIStateBlock(repo, rootBlock.id, user))

  useEffect(() => {
    uiStateBlock.change(doc => {
      doc.properties.topLevelBlockId = topLevelBlockId
    })
  }, [topLevelBlockId])

  updateLoadTimes(uiStateBlock)
}

const App = () => {
  const repo = useRepo()
  const location = useLocation()
  const safeMode = Boolean(useSearchParam('safeMode'))

  const rootDocUrl = location.hash?.substring(1)
  const handle = use(getInitialBlock(repo, rootDocUrl))
  const docId = document.location.hash = handle.id

  const rootBlock = use(getRootBlock(repo.find(docId)))
  useInitUIState(rootBlock, docId)

  return (
    <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
      <BlockComponent blockId={docId}/>
    </BlockContextProvider>
  )
}

export default App
