import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {
  useAnnotationSurface,
  type HighlightRange,
  type SurfaceGesture,
} from '@/plugins/annotations/surface.ts'
import {showError, showInfo} from '@/utils/toast.js'
import {NO_MARKS, type FrameScripts, type FrameSelection} from './frameDocument.ts'
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
    loadSourceMap().then(setMap, (error: unknown) => console.error('html-document: could not load the source map', error))
  }, [wanted, map])
  return map
}

const NO_HIGHLIGHTS: readonly HighlightRange[] = Object.freeze([])

/** Gap between the selection and the gestures beside it. */
const GAP = 4

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))

interface Size {
  width: number
  height: number
}

/** Where the gestures go in a frame of `frame` size, `bar` being their own
 *  size: below the selection, or above it where below runs out of the frame,
 *  and always inside the frame's box, so nothing a document reports can put
 *  them over the strip above. Null while the selection is outside the frame
 *  (scrolled out of a tall document's box): placed anyway, they would sit
 *  over other text. */
export const gesturesPlacement = (
  rect: FrameSelection['rect'],
  frame: Size,
  bar: Size,
): {top: number; left: number} | null => {
  if (rect.bottom < 0 || rect.top > frame.height || rect.right < 0 || rect.left > frame.width) return null
  const below = rect.bottom + GAP
  const top = below + bar.height <= frame.height ? below : rect.top - GAP - bar.height
  return {top: clamp(top, 0, frame.height - bar.height), left: clamp(rect.left, 0, frame.width - bar.width)}
}

/** Placed before paint, from its own size. A press anywhere else in the app
 *  dismisses it; a press inside the frame never reaches the app, and the
 *  document reports its own selection. */
const SelectionGestures = ({selection, gestures, running, onRun, onDismiss}: {
  selection: FrameSelection
  gestures: readonly SurfaceGesture[]
  /** A gesture is under way: a second would act on the same selection. */
  running: boolean
  onRun: (gesture: SurfaceGesture) => void
  onDismiss: () => void
}) => {
  const bar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = bar.current
    const holder = element?.offsetParent
    if (!element || !(holder instanceof HTMLElement)) return
    element.hidden = false
    const place = gesturesPlacement(
      selection.rect,
      {width: holder.clientWidth, height: holder.clientHeight},
      {width: element.offsetWidth, height: element.offsetHeight},
    )
    element.hidden = place === null
    if (!place) return
    element.style.top = `${place.top}px`
    element.style.left = `${place.left}px`
  }, [selection])
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && bar.current?.contains(event.target))) onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onDismiss])
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
  const drawsMarks = scripts === 'hold' && highlights.length > 0
  const map = useSourceMap(drawsMarks || selection !== null)
  const marks = useMemo(
    () => map && drawsMarks ? map.marksOf(source, highlights) : NO_MARKS,
    [map, drawsMarks, source, highlights],
  )
  const [running, setRunning] = useState(false)
  const frame = useRef<HtmlFrameHandle>(null)
  const dismiss = useCallback(() => frame.current?.clearSelection(), [])

  const run = async (gesture: SurfaceGesture, held: FrameSelection) => {
    setRunning(true)
    try {
      // Once the map has loaded, which the selection set going, nothing is
      // awaited before the gesture starts (`SurfaceGesture.run`).
      const loaded = map ?? await loadSourceMap()
      const range = loaded.rangeOfSelection(source, held)
      if (typeof range === 'string') showInfo(range)
      else if (await gesture.run({content: source, ...range})) frame.current?.clearSelection()
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
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
          onRun={gesture => { void run(gesture, selection) }}
          onDismiss={dismiss}
        />
      )}
    </div>
  )
}
