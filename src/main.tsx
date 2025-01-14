import React, {StrictMode} from 'react'
import ReactDOM from 'react-dom'
import {createRoot} from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import {isValidAutomergeUrl} from '@automerge/automerge-repo'
import {RepoContext} from '@automerge/automerge-repo-react-hooks'
import {v4 as uuidv4} from 'uuid'
import {importState} from './utils/state.ts'
import {BlockData} from './types.ts'
import {repo} from '@/data/repo.ts'

window.React = React
window.ReactDOM = ReactDOM

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle
if (isValidAutomergeUrl(rootDocUrl)) {
    handle = repo.find(rootDocUrl)
} else {
    const blockMap = await importState({blocks: getExampleBlocks()}, repo)
    console.log('Created example blocks:', blockMap)
    handle = blockMap.values().next().value
    console.log('Created example blocks:', handle)
}
const docUrl = document.location.hash = handle.url
const isSafeMode = new URLSearchParams(window.location.search).has('safeMode')

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <RepoContext.Provider value={repo}>
            <App docId={docUrl} safeMode={isSafeMode} />
        </RepoContext.Provider>
    </StrictMode>,
)


function getExampleBlocks(): BlockData[] {
    const rootId = uuidv4()
    const child1Id = uuidv4()
    const child2Id = uuidv4()
    const child3Id = uuidv4()

    return [
        {
            id: rootId,
            content: 'Hello World\nThis is a multiline\ntext block',
            properties: {},
            childIds: [child1Id, child2Id, child3Id],
        },
        {
            id: child1Id,
            content: 'A normal text block\nwith multiple lines',
            properties: {},
            childIds: [],
            parentId: rootId,
        },
        {
            id: child2Id,
            content: `import { DefaultBlockRenderer } from "@/components/DefaultBlockRenderer"; 
 
function ContentRenderer({ block, changeBlock }) {
    return <div style={{ color: "green" }}>
        Custom renderer for: {block.content}
        <button onClick={() => changeBlock(block => block.content = block.content + '!')}>
            Add !
        </button>
    </div>
}


// By default, renderer is responsible for rendering everything in the block (including controls/etc), 
// but we often want to just update how content of the block is rendered and leave everything else untouched, 
// Here is an example of doing that
export default ({ block, changeBlock }) => <DefaultBlockRenderer block={block} changeBlock={changeBlock} ContentRenderer={ContentRenderer}/> 
`,
            properties: {type: 'renderer'},
            childIds: [],
            parentId: rootId,
        },
        {
            id: child3Id,
            content: 'This block uses the custom renderer',
            // todo import wont' update this rn, so need to manually set the new renderer id
            //  generally unclear how to handle this for (arbitrary field that contains id of another block)
            properties: {renderer: child2Id},
            childIds: [],
            parentId: rootId,
        }
    ]
}
