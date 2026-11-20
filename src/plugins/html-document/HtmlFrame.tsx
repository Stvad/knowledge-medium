import {useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref} from 'react'
import {
  buildFrameDocument,
  CLEAR_SELECTION_MESSAGE_TYPE,
  documentWindowOf,
  FRAME_SANDBOX,
  MARKS_MESSAGE_TYPE,
  NO_MARKS,
  readFrameReport,
  type FrameMarks,
  type FrameScripts,
  type FrameSelection,
} from './frameDocument.ts'
import {useFrameThemeCss} from './frameTheme.ts'

const INITIAL_FRAME_HEIGHT = 150

export interface HtmlFrameHandle {
  clearSelection: () => void
}

interface HtmlFrameProps {
  source: string
  scripts: FrameScripts
  /** Drawn only while scripts are held: a running document could read them. */
  marks?: FrameMarks
  /** The reader's selection in the document, or null once there is none. */
  onSelection?: (selection: FrameSelection | null) => void
  ref?: Ref<HtmlFrameHandle>
}

/** Runs `source` in the sandbox `frameDocument.ts` describes, and speaks its
 *  protocol with the one window that may: any other frame on the page can post
 *  here too. Reports apply once per frame of the page's own rendering, so a
 *  document posting in a loop can't drive React. */
export const HtmlFrame = ({source, scripts, marks = NO_MARKS, onSelection, ref}: HtmlFrameProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const themeCss = useFrameThemeCss()
  const srcDoc = useMemo(() => buildFrameDocument(source, themeCss, scripts), [source, themeCss, scripts])
  const [height, setHeight] = useState(INITIAL_FRAME_HEIGHT)
  /** Null for a running document, which is sent no marks at all. */
  const sent = scripts === 'hold' ? marks : null
  /** What the message listener reads, set after each commit. */
  const latest = useRef({marks: sent, onSelection})
  /** The window that said it is ready for marks; a new frame has to say so again. */
  const ready = useRef<Window | null>(null)

  /** To the current document, once it is ready; until then nothing reads it. */
  const post = useCallback((message: unknown) => {
    const frame = frameRef.current
    const target = frame && documentWindowOf(frame)
    if (target && target === ready.current) target.postMessage(message, '*')
  }, [])

  /** The one way marks leave: the latest committed, and never to a running
   *  document. */
  const sendMarks = useCallback(() => {
    const {marks: held} = latest.current
    if (held) post({type: MARKS_MESSAGE_TYPE, digest: held.digest, marks: held.marks})
  }, [post])

  useImperativeHandle(ref, () => ({clearSelection: () => post({type: CLEAR_SELECTION_MESSAGE_TYPE})}), [post])

  useLayoutEffect(() => {
    latest.current = {marks: sent, onSelection}
  })

  useEffect(sendMarks, [sendMarks, sent])

  // A new document starts with no selection.
  useEffect(() => () => latest.current.onSelection?.(null), [srcDoc])

  // Layout, not passive: a document may report once, as soon as it loads. A message
  // is always delivered in a later task than this commit, but a passive effect can
  // run after it, and that report would be lost with no second one coming.
  useLayoutEffect(() => {
    let scheduled: number | undefined
    let pendingHeight: number | undefined
    let pendingSelection: {selection: FrameSelection | null} | undefined
    const apply = () => {
      scheduled = undefined
      if (pendingHeight !== undefined) setHeight(pendingHeight)
      if (pendingSelection) latest.current.onSelection?.(pendingSelection.selection)
      pendingHeight = undefined
      pendingSelection = undefined
    }
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      const from = frame && documentWindowOf(frame)
      if (!from || event.source !== from) return
      const report = readFrameReport(event.data)
      if (!report) return
      if (report.kind === 'ready') {
        ready.current = from
        sendMarks()
        return
      }
      if (report.kind === 'height') pendingHeight = report.height
      else pendingSelection = {selection: report.selection}
      scheduled ??= requestAnimationFrame(apply)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (scheduled !== undefined) cancelAnimationFrame(scheduled)
    }
  }, [sendMarks])

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
