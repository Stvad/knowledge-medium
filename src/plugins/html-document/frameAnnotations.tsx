import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {
  useAnnotationSurface,
  type SurfaceGesture,
  type SurfaceHighlight,
} from '@/plugins/annotations/surface.ts'
import {showError, showInfo} from '@/utils/toast.js'
import type {FrameMark, FrameScripts, FrameSelection} from './frameDocument.ts'
import {HtmlFrame, type HtmlFrameHandle} from './HtmlFrame.tsx'

type SourceMap = typeof import('./sourceMap.ts')

let loadedSourceMap: SourceMap | null = null
const loadSourceMap = (): Promise<SourceMap> => import('./sourceMap.ts').then(map => (loadedSourceMap = map))

/** The source map, once loaded; it loads while `wanted`. It carries an HTML
 *  parser, so it loads only once there is something to draw or a selection to
 *  place. Until then, and if it fails to load, the frame draws nothing, and the
 *  threads still show their quotes. */
const useSourceMap = (wanted: boolean): SourceMap | null => {
  const [map, setMap] = useState(loadedSourceMap)
  useEffect(() => {
    if (!wanted || map) return
    let live = true
    loadSourceMap().then(
      loaded => { if (live) setMap(loaded) },
      (error: unknown) => console.error('html-document: could not load the source map', error),
    )
    return () => { live = false }
  }, [wanted, map])
  return map
}

const NO_HIGHLIGHTS: readonly SurfaceHighlight[] = Object.freeze([])
const NO_MARKS: readonly FrameMark[] = Object.freeze([])

/** Gap between the selection and the gestures beside it. */
const GAP = 4

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
 *  around its block (`annotations/surface.ts`). Where there is none, the frame
 *  reports no selection and draws nothing. */
export const AnnotatedFrame = ({blockId, source, scripts}: {blockId: string; source: string; scripts: FrameScripts}) => {
  const surface = useAnnotationSurface(blockId)
  const highlights = useMemo(() => surface?.highlightsIn(source) ?? NO_HIGHLIGHTS, [surface, source])
  const [selection, setSelection] = useState<FrameSelection | null>(null)
  const map = useSourceMap(highlights.length > 0 || selection !== null)
  const marks = useMemo(
    () => map && highlights.length > 0 ? map.marksOf(map.textSpansOf(source), highlights) : NO_MARKS,
    [map, source, highlights],
  )
  const [running, setRunning] = useState(false)
  const frame = useRef<HtmlFrameHandle>(null)

  /** Starts the gesture inside the click once the source map has loaded, which
   *  the selection set going: a gesture that writes the clipboard must start
   *  the write there, as Safari refuses one started after an await. */
  const run = (gesture: SurfaceGesture, held: FrameSelection): Promise<void> => {
    const place = (loaded: SourceMap) => {
      const range = loaded.rangeOfSelection(loaded.textSpansOf(source), held, scripts)
      if (typeof range === 'string') {
        showInfo(range)
        return Promise.resolve()
      }
      return gesture.run({content: source, ...range}).then(landed => {
        if (landed) frame.current?.clearSelection()
      })
    }
    return map ? place(map) : loadSourceMap().then(place)
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
