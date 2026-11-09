/**
 * The contract between annotations and a block content renderer that draws the
 * block's text itself, outside the markdown pipeline (an HTML document's frame,
 * say): the renderer maps its own selection to a raw range of the content and
 * back, and annotations keeps the anchors, the threads and the gestures. Read
 * mode's markdown does the same inside this plugin (`readSelection.ts`,
 * `readHighlights.ts`).
 *
 * Provided around outline blocks' content, where the gestures run; a renderer
 * that finds none offers no gestures and draws no highlights.
 */

import {createContext, useContext} from 'react'
import type {LucideIcon} from 'lucide-react'
import type {ContentRange} from './actions.ts'
import type {HighlightRange} from './highlights.ts'

export type {ContentRange}
export type SurfaceHighlight = HighlightRange

export interface SurfaceGesture {
  id: string
  label: string
  icon: LucideIcon
  /** Runs on a range of the block's content, showing why it can't where it
   *  can't. True once it landed, when the renderer should drop its selection
   *  so it doesn't sit over the new highlight. */
  run: (range: ContentRange) => Promise<boolean>
}

export interface AnnotationSurface {
  /** Where open threads highlight `content`, the text the renderer draws. */
  highlightsIn: (content: string) => readonly SurfaceHighlight[]
  gestures: readonly SurfaceGesture[]
}

export const AnnotationSurfaceContext = createContext<AnnotationSurface | null>(null)

export const useAnnotationSurface = (): AnnotationSurface | null => useContext(AnnotationSurfaceContext)
