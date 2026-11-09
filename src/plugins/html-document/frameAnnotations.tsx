import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {
  useAnnotationSurface,
  type SurfaceGesture,
  type SurfaceHighlight,
} from '@/plugins/annotations/surface.ts'
import {showError, showInfo} from '@/utils/toast.js'
import type {FrameMark, FrameScripts, FrameSelection} from './frameDocument.ts'
import {HtmlFrame, type HtmlFrameHandle} from './HtmlFrame.tsx'

const loadSourceMap = () => import('./sourceMap.ts')

const NO_HIGHLIGHTS: readonly SurfaceHighlight[] = Object.freeze([])
const NO_MARKS: readonly FrameMark[] = Object.freeze([])

/** Gap between the selection and the gestures beside it. */
const GAP = 4

/** The highlights as the frame draws them. The parser loads only once there is
 *  something to draw; until then, and if it fails to load, the frame draws
 *  none, and the threads still show their quotes. */
const useFrameMarks = (source: string, highlights: readonly SurfaceHighlight[]): readonly FrameMark[] => {
  const [drawn, setDrawn] = useState<{
    source: string
    highlights: readonly SurfaceHighlight[]
    marks: readonly FrameMark[]
  } | null>(null)
  useEffect(() => {
    if (highlights.length === 0) return
    let live = true
    loadSourceMap().then(
      map => { if (live) setDrawn({source, highlights, marks: map.marksOf(map.textSpansOf(source), highlights)}) },
      (error: unknown) => console.error('html-document: could not load the source map for highlights', error),
    )
    return () => { live = false }
  }, [source, highlights])
  return drawn?.source === source && drawn.highlights === highlights ? drawn.marks : NO_MARKS
}

/** Below the selection, or above it where below runs out of the frame, and
 *  inside the frame's width. Placed before paint, from its own size. */
const SelectionGestures = ({selection, gestures, running, onRun}: {
  selection: FrameSelection
  gestures: readonly SurfaceGesture[]
  /** A gesture is under way: a second would act on the same selection. */
  running: boolean
  onRun: (gesture: SurfaceGesture) => void
}) => {
  const bar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = bar.current
    const holder = element?.offsetParent
    if (!element || !(holder instanceof HTMLElement)) return
    const {rect} = selection
    const height = element.offsetHeight
    const below = rect.bottom + GAP
    const top = below + height <= holder.clientHeight ? below : Math.max(0, rect.top - GAP - height)
    const left = Math.min(Math.max(0, rect.left), Math.max(0, holder.clientWidth - element.offsetWidth))
    element.style.top = `${top}px`
    element.style.left = `${left}px`
  }, [selection])
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Selected text"
      className="absolute left-0 top-0 z-10 flex gap-0.5 rounded-md border border-border bg-background p-0.5 text-xs shadow-md"
    >
      {gestures.map(gesture => (
        <button
          key={gesture.id}
          type="button"
          disabled={running}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
          onClick={() => onRun(gesture)}
        >
          <gesture.icon className="size-3.5"/>
          {gesture.label}
        </button>
      ))}
    </div>
  )
}

/** The frame, with comments on its text through the annotations surface
 *  around the block (`annotations/surface.ts`). Where there is none, the frame
 *  reports no selection and draws nothing. The selection is mapped to the
 *  source when a gesture runs, not as it changes, so the parser loads only on
 *  use. */
export const AnnotatedFrame = ({source, scripts}: {source: string; scripts: FrameScripts}) => {
  const surface = useAnnotationSurface()
  const highlights = useMemo(() => surface?.highlightsIn(source) ?? NO_HIGHLIGHTS, [surface, source])
  const marks = useFrameMarks(source, highlights)
  const [selection, setSelection] = useState<FrameSelection | null>(null)
  const [running, setRunning] = useState(false)
  const frame = useRef<HtmlFrameHandle>(null)

  const run = async (gesture: SurfaceGesture, held: FrameSelection) => {
    const map = await loadSourceMap()
    const range = map.rangeOfSelection(map.textSpansOf(source), held)
    if (typeof range === 'string') {
      showInfo(range)
      return
    }
    if (await gesture.run({content: source, ...range})) frame.current?.clearSelection()
  }

  return (
    <div className="relative">
      <HtmlFrame
        ref={frame}
        source={source}
        scripts={scripts}
        marks={marks}
        onSelection={surface ? setSelection : undefined}
      />
      {surface && selection && surface.gestures.length > 0 && (
        <SelectionGestures
          selection={selection}
          gestures={surface.gestures}
          running={running}
          onRun={gesture => {
            setRunning(true)
            run(gesture, selection)
              .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)))
              .finally(() => setRunning(false))
          }}
        />
      )}
    </div>
  )
}
