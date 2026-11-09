/** The page the boundary suite attacks from inside a frame: the real
 *  `HtmlFrame`, under an origin holding a secret in every place the app keeps
 *  anything. Bundled and served by `boundaryHarness.ts`. */

import {createRef} from 'react'
import {createRoot} from 'react-dom/client'
import type {FrameMark, FrameScripts, FrameSelection} from '../frameDocument.ts'
import {HtmlFrame, type HtmlFrameHandle} from '../HtmlFrame.tsx'

declare global {
  interface Window {
    reports: unknown[]
    channelReports: unknown[]
    /** Every selection the frame handed up, latest last. */
    selections: (FrameSelection | null)[]
    kmSecret: string
    secretsReady: Promise<void>
    mountSandboxed: (source: string, scripts?: FrameScripts, marks?: FrameMark[]) => void
    clearSelection: () => void
    mountControl: (source: string) => void
  }
}

const storeInIndexedDb = () => new Promise<void>((resolve, reject) => {
  const open = indexedDB.open('km-secret', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('s')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const tx = open.result.transaction('s', 'readwrite')
    tx.objectStore('s').put('KM_SECRET_indexedDB', 'k')
    tx.oncomplete = () => {
      open.result.close()
      resolve()
    }
  }
})

const storeInOpfs = async () => {
  const root = await navigator.storage.getDirectory()
  const writable = await (await root.getFileHandle('km-secret', {create: true})).createWritable()
  await writable.write('KM_SECRET_opfs')
  await writable.close()
}

const storeInCache = async () => {
  const cache = await caches.open('km-secret')
  await cache.put('/km-secret', new Response('KM_SECRET_cacheStorage'))
}

/** A store an engine's build lacks fails that one probe's control, where the
 *  suite names it, rather than taking the whole host down. */
const storeSecrets = async () => {
  document.cookie = 'km_secret=KM_SECRET_cookie; path=/'
  localStorage.setItem('km_secret', 'KM_SECRET_localStorage')
  sessionStorage.setItem('km_secret', 'KM_SECRET_sessionStorage')
  window.kmSecret = 'KM_SECRET_global'
  await Promise.allSettled([storeInIndexedDb(), storeInOpfs(), storeInCache()])
}

window.reports = []
window.channelReports = []
window.addEventListener('message', event => window.reports.push(event.data))
new BroadcastChannel('km-secret').onmessage = event => window.channelReports.push(event.data)
window.secretsReady = storeSecrets()

const mount = document.getElementById('mount') as HTMLElement
const root = createRoot(mount)

const frame = createRef<HtmlFrameHandle>()
window.selections = []
const onSelection = (selection: FrameSelection | null) => window.selections.push(selection)

window.mountSandboxed = (source, scripts = 'run', marks) => root.render(
  <HtmlFrame ref={frame} source={source} scripts={scripts} marks={marks} onSelection={onSelection}/>,
)
window.clearSelection = () => frame.current?.clearSelection()

/** The same document with no sandbox: every probe must succeed here, or its
 *  failure under the sandbox proves nothing. */
window.mountControl = source => root.render(<iframe srcDoc={source} style={{width: '100%', height: 200}}/>)
