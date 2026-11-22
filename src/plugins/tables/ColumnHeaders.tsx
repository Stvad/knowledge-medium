/** The column headers and the column gestures they carry: drag a header's
 *  edge to resize, drag the header to reorder, and its menu to hide, delete
 *  or add the property to a type. Every gesture writes once, when it ends. */
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref, type UIEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { PropertyPicker } from '@/components/propertyPanel/PropertyPicker'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Block } from '@/data/block'
import { adoptOrCreatePropertySchema } from '@/data/propertySchemaCreation'
import { NO_BLOCK_GESTURES_ATTRIBUTE } from '@/extensions/continuousGestures'
import {
  addColumn, addColumnForChoice, addPropertyToType, columnWidthFor, deleteColumn, moveColumn, resizeColumn, setColumnHidden,
  typeTargetsFor, type TypeTarget,
} from './columns'
import type { TableColumn } from './model'

/** A pointer that travels less than this is a click, not a drag. */
const DRAG_THRESHOLD = 5

const noGestures = {[NO_BLOCK_GESTURES_ATTRIBUTE]: 'true'}

/** Report a failed write; the gesture itself has already ended. */
const report = (what: string) => (error: unknown) => { console.error(`[tables] ${what} failed`, error) }

export interface ResizePreview {
  readonly columnId: string
  readonly width: number
  /** Released and being written: shown until the stored width matches. */
  readonly committed?: boolean
}

/** Where a dragged header would land: before the visible column at `slot`,
 *  or after the last one when `slot` is the column count. */
const dropSlot = (cells: readonly HTMLElement[], x: number): number => {
  const index = cells.findIndex(cell => {
    const box = cell.getBoundingClientRect()
    return x < box.left + box.width / 2
  })
  return index < 0 ? cells.length : index
}

interface HeaderProps {
  host: Block
  workspaceId: string
  columns: readonly TableColumn[]
  names: readonly string[]
  template: CSSProperties
  scrollRef: Ref<HTMLDivElement>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  rowIds: readonly string[]
  editable: boolean
  onResizePreview: (preview: ResizePreview | null) => void
}

export const ColumnHeaders = ({
  host, workspaceId, columns, names, template, scrollRef, onScroll, rowIds, editable, onResizePreview,
}: HeaderProps) => {
  const rowRef = useRef<HTMLDivElement>(null)
  /** The dragged column and where its drop indicator stands, in px from the row's left edge. */
  const [drag, setDrag] = useState<{columnId: string; indicator: number} | null>(null)
  const cells = () => [...rowRef.current?.querySelectorAll<HTMLElement>(':scope > [role="columnheader"]') ?? []]

  /** Drag a header to reorder. A press that never travels is left alone. The
   *  window listens, so a pointer that leaves the header before it counts as a
   *  drag is still followed. */
  const startReorder = (event: ReactPointerEvent<HTMLElement>, columnId: string) => {
    if (!editable || event.button !== 0) return
    const pointerId = event.pointerId
    const startX = event.clientX
    let slot: number | null = null
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (slot === null && Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD) return
      moveEvent.preventDefault()
      const headers = cells()
      slot = dropSlot(headers, moveEvent.clientX)
      setDrag({columnId, indicator: indicatorLeft(headers, rowRef.current!, slot)})
    }
    const finish = (endEvent: PointerEvent, drop: boolean) => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setDrag(null)
      if (!drop || slot === null) return
      const from = columns.findIndex(column => column.id === columnId)
      // Its own slot, or the one just after it, is where it already is.
      if (slot === from || slot === from + 1) return
      const anchor = slot < columns.length
        ? {side: 'before' as const, columnId: columns[slot]!.id}
        : {side: 'after' as const, columnId: columns[columns.length - 1]!.id}
      void moveColumn(host.repo, columnId, anchor).catch(report('column move'))
    }
    const up = (upEvent: PointerEvent) => finish(upEvent, true)
    const cancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} {...noGestures} className="sticky top-0 z-[2] overflow-hidden border-b border-border bg-background">
      <div ref={rowRef} role="row" className="relative grid text-sm font-medium" style={template}>
        {columns.map((column, index) => (
          <div key={column.id} role="columnheader" data-table-column={column.id}
            className={`group relative flex min-w-0 items-center border-r border-border ${index === 0 ? 'sticky left-0 z-[1] bg-background' : ''} ${drag?.columnId === column.id ? 'opacity-50' : ''}`}>
            <span data-table-column-drag="true"
              className={`min-w-0 flex-1 truncate px-2 py-1 ${editable ? 'cursor-grab touch-pan-y select-none' : ''}`}
              onPointerDown={event => startReorder(event, column.id)}>
              {names[index]}
            </span>
            {editable && <ColumnMenu host={host} workspaceId={workspaceId} column={column} name={names[index]!}
              rowIds={rowIds}/>}
            {editable && <ResizeHandle column={column} onPreview={onResizePreview}
              commit={width => resizeColumn(host.repo, column.id, width)}/>}
          </div>
        ))}
        {drag && <div data-table-drop-indicator="true" aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-[3] w-0.5 bg-ring" style={{left: drag.indicator}}/>}
      </div>
    </div>
  )
}

const indicatorLeft = (cells: readonly HTMLElement[], row: HTMLElement, slot: number): number => {
  if (cells.length === 0) return 0
  const origin = row.getBoundingClientRect().left
  const edge = slot < cells.length ? cells[slot]!.getBoundingClientRect().left : cells[cells.length - 1]!.getBoundingClientRect().right
  return edge - origin - 1
}

/** Drag the header's right edge. The width shows live and is written once, on
 *  release; Escape or a cancelled pointer puts it back. */
const ResizeHandle = ({column, onPreview, commit}: {
  column: TableColumn
  onPreview: (preview: ResizePreview | null) => void
  commit: (width: number) => Promise<void>
}) => {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const header = handle.closest<HTMLElement>('[role="columnheader"]')
    if (!header) return
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    const startX = event.clientX
    const startWidth = header.getBoundingClientRect().width
    let width: number | null = null
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      width = columnWidthFor(startWidth + moveEvent.clientX - startX)
      onPreview({columnId: column.id, width})
    }
    const finish = (save: boolean) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      if (!save || width === null || width === column.width) {
        onPreview(null)
        return
      }
      onPreview({columnId: column.id, width, committed: true})
      void commit(width).catch(error => {
        onPreview(null)
        report('column resize')(error)
      })
    }
    const up = (upEvent: PointerEvent) => { if (upEvent.pointerId === pointerId) finish(true) }
    const cancel = (cancelEvent: PointerEvent) => { if (cancelEvent.pointerId === pointerId) finish(false) }
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      finish(false)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape, true)
  }

  // Wider than the line it shows, so a finger can take it.
  return <div data-table-resize={column.id} role="separator" aria-orientation="vertical" aria-label="Resize column"
    className="group/resize absolute inset-y-0 -right-2 z-[2] flex w-4 cursor-col-resize touch-none justify-center"
    onPointerDown={start}>
    <div className="h-full w-0.5 group-hover/resize:bg-ring/60"/>
  </div>
}

const ColumnMenu = ({host, workspaceId, column, name, rowIds}: {
  host: Block; workspaceId: string; column: TableColumn; name: string; rowIds: readonly string[]
}) => {
  const [types, setTypes] = useState<readonly TypeTarget[]>([])
  const fieldId = column.fieldId
  const open = (isOpen: boolean) => {
    if (!isOpen || fieldId === null) return
    void typeTargetsFor(host.repo, workspaceId, rowIds, fieldId).then(setTypes, report('type lookup'))
  }
  const repo = host.repo
  return (
    <DropdownMenu onOpenChange={open}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-table-column-menu={column.id} aria-label={`${name} column menu`}
          className="mr-1 shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100 group-hover:opacity-100">
          <ChevronDown className="h-3.5 w-3.5"/>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onSelect={() => { void setColumnHidden(repo, column.id, true).catch(report('column hide')) }}>
          Hide column
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void deleteColumn(repo, column.id).catch(report('column delete')) }}>
          Delete column
        </DropdownMenuItem>
        {fieldId !== null && types.length > 0 && <DropdownMenuSeparator/>}
        {fieldId !== null && types.map(type => (
          <DropdownMenuItem key={type.typeId}
            onSelect={() => { void addPropertyToType(repo, type.typeBlockId, fieldId).catch(report('add to type')) }}>
            Add to #{type.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Below the grid: add a column, and show the hidden ones again. */
export const ColumnToolbar = ({host, viewId, hidden, hiddenNames, hasContentColumn}: {
  host: Block
  viewId: string
  hidden: readonly TableColumn[]
  hiddenNames: readonly string[]
  hasContentColumn: boolean
}) => {
  const [adding, setAdding] = useState(0)
  const repo = host.repo
  const userSchemas = repo.userSchemas
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {adding > 0
        ? <div className="w-56" data-table-add-column-picker="true">
          <PropertyPicker key={adding} block={host} autoFocus placeholder="Column property"
            filterSchema={schema => userSchemas.getSchemaBlockId(schema.name) !== undefined}
            onAdd={async choice => {
              await addColumnForChoice(repo, viewId, choice)
              setAdding(0)
            }}
            // The glyph registers the property; the picker then submits it to onAdd.
            onConfigureNewSchema={async choice => (await adoptOrCreatePropertySchema(repo, choice)).schema}
            onEscape={() => setAdding(0)}/>
        </div>
        : <button type="button" data-table-add-column="true" className="px-2 py-1 hover:text-foreground"
          onClick={() => setAdding(key => key + 1)}>+ Add column</button>}
      {!hasContentColumn && <button type="button" className="px-2 py-1 hover:text-foreground"
        onClick={() => { void addColumn(repo, viewId, null).catch(report('add title column')) }}>+ Title column</button>}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-table-hidden-columns="true" className="px-2 py-1 hover:text-foreground">
              {hidden.length} hidden
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {hidden.map((column, index) => (
              <DropdownMenuItem key={column.id} data-table-show-column={column.id}
                onSelect={() => { void setColumnHidden(repo, column.id, false).catch(report('column show')) }}>
                Show {hiddenNames[index]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
