import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useRepo } from '@/context/repo.js'
import {
  createBlockDragController,
  DRAG_ACTIVE_ATTRIBUTE,
  DRAGGING_ROW_ATTRIBUTE,
} from './dragController.ts'

/** Dragged rows are dimmed and the page shows a grabbing cursor without
 *  text selection — all by attribute, so no row re-renders for it. */
const DRAG_STYLES = `
[${DRAGGING_ROW_ATTRIBUTE}] { opacity: 0.4; }
html[${DRAG_ACTIVE_ATTRIBUTE}], html[${DRAG_ACTIVE_ATTRIBUTE}] * {
  cursor: grabbing !important;
  user-select: none !important;
}
`

/** App mount for block drag-and-drop: installs the document-level start
 *  listener and draws the drop line. The only component that re-renders
 *  while a drag is in flight. */
export function BlockDragLayer() {
  const repo = useRepo()
  const controller = useMemo(() => createBlockDragController(repo), [repo])
  useEffect(() => controller.install(), [controller])
  const {active, line} = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  if (!active) return null

  return (
    <>
      <style>{DRAG_STYLES}</style>
      {line && (
        <div
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-50 h-0.5 rounded-full bg-primary"
          style={{transform: `translate(${line.x}px, ${line.y - 1}px)`, width: line.width}}
        >
          <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full border-2 border-primary bg-background"/>
        </div>
      )}
    </>
  )
}
