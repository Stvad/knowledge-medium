/**
 * The contract between annotations and a block content renderer that draws the
 * block's text itself, outside the markdown pipeline (an HTML document's frame,
 * say): the renderer maps its own selection to a raw range of the content and
 * back, and annotations keeps the anchors, the threads and the gestures. Read
 * mode's markdown does the same inside this plugin (`readSelection.ts`,
 * `readHighlights.ts`).
 *
 * Provided around outline blocks' content, where the gestures run; a renderer
 * that finds none for its own block offers no gestures and draws no highlights.
 */

import {createContext, useContext} from 'react'
import type {LucideIcon} from 'lucide-react'
import {useBlockContext} from '@/context/block.js'
import type {ContentRange} from './actions.ts'
import type {HighlightRange} from './highlights.ts'

export type {ContentRange, HighlightRange}

/** What something annotations provides around a block's content belongs to:
 *  that block, rendered in that scope. */
export interface ProvidedFor {
  blockId: string
  renderScopeId: string | undefined
}

/** Is `provided` this block's, in this scope? What renders inside the content
 *  (an embed, a block reference, the block shown inside itself) inherits the
 *  provider, and is another block or scope, which takes its own or none. */
export const providedHere = <T extends ProvidedFor>(
  provided: T | null | undefined,
  blockId: string,
  renderScopeId: string | undefined,
): provided is T => !!provided && provided.blockId === blockId && provided.renderScopeId === renderScopeId

export interface SurfaceGesture {
  id: string
  label: string
  icon: LucideIcon
  /** Runs on a range of the block's content, showing why it can't where it
   *  can't. True once it landed, when the renderer should drop its selection
   *  so it doesn't sit over the new highlight. A gesture that writes the
   *  clipboard starts the write before it first awaits, so call it inside the
   *  user's click. */
  run: (range: ContentRange) => Promise<boolean>
}

export interface AnnotationSurface extends ProvidedFor {
  /** Where open threads highlight `content`, the text the renderer draws. */
  highlightsIn: (content: string) => readonly HighlightRange[]
  gestures: readonly SurfaceGesture[]
}

export const AnnotationSurfaceContext = createContext<AnnotationSurface | null>(null)

/** The surface for `blockId` as rendered here, or null. */
export const useAnnotationSurface = (blockId: string): AnnotationSurface | null => {
  const surface = useContext(AnnotationSurfaceContext)
  const {renderScopeId} = useBlockContext()
  return providedHere(surface, blockId, renderScopeId) ? surface : null
}
