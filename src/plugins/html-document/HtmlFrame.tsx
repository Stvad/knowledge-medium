import {useLayoutEffect, useMemo, useRef, useState} from 'react'
import {buildFrameDocument, documentWindowOf, FRAME_SANDBOX, readReportedHeight, type FrameScripts} from './frameDocument.ts'
import {useFrameThemeCss} from './frameTheme.ts'

const INITIAL_FRAME_HEIGHT = 150

/** Runs `source` in the sandbox `frameDocument.ts` describes. The only thing it
 *  reads back is a height, from the one window that may report it; any other
 *  frame on the page can post here too. Heights apply once per frame of the
 *  page's own rendering, so a document posting in a loop can't drive React. */
export const HtmlFrame = ({source, scripts}: {source: string; scripts: FrameScripts}) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const themeCss = useFrameThemeCss()
  const srcDoc = useMemo(() => buildFrameDocument(source, themeCss, scripts), [source, themeCss, scripts])
  const [height, setHeight] = useState(INITIAL_FRAME_HEIGHT)

  // Layout, not passive: a document may report once, as soon as it loads. A message
  // is always delivered in a later task than this commit, but a passive effect can
  // run after it, and that report would be lost with no second one coming.
  useLayoutEffect(() => {
    let scheduled: number | undefined
    let latest = INITIAL_FRAME_HEIGHT
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== documentWindowOf(frame)) return
      const reported = readReportedHeight(event.data)
      if (reported === null) return
      latest = reported
      scheduled ??= requestAnimationFrame(() => {
        scheduled = undefined
        setHeight(latest)
      })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (scheduled !== undefined) cancelAnimationFrame(scheduled)
    }
  }, [])

  return (
    <iframe
      // A new frame per version: changing the srcdoc of a live one adds an entry to
      // the page's history, so Back could return to a version since stopped.
      key={srcDoc}
      ref={frameRef}
      // Ahead of `srcDoc`: the sandbox must be in place when navigation starts.
      sandbox={FRAME_SANDBOX}
      srcDoc={srcDoc}
      title="HTML document"
      style={{display: 'block', width: '100%', border: 0, height}}
    />
  )
}
