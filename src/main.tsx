import React, {StrictMode} from 'react'
import ReactDOM from 'react-dom'
import {createRoot} from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { importState } from './utils/state.ts'
import { repo as automergeRepo, Repo } from '@/data/repo'
import { RepoProvider } from '@/context/repo.tsx'
import { getExampleBlocks } from '@/initData.ts'
import { Block } from '@/data/block.ts'

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

const repo = new Repo(automergeRepo)

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle: Block
if (isValidAutomergeUrl(rootDocUrl)) {
    handle = repo.find(rootDocUrl)
} else {
    const blockMap = await importState({blocks: getExampleBlocks()}, repo)
    console.log('Created example blocks:', blockMap)
    handle = blockMap.values().next().value!
    console.log('Created example blocks:', handle)
}
const docUrl = document.location.hash = handle.id
const isSafeMode = new URLSearchParams(window.location.search).has('safeMode')


createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <RepoProvider value={repo}>
            <App docId={docUrl} safeMode={isSafeMode} />
        </RepoProvider>
    </StrictMode>,
)


//  generally unclear how to handle this for (arbitrary field that contains id of another block)
