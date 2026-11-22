/** The column headers and the column gestures they carry: click a header to
 *  sort by it, drag its edge to resize, drag the header to reorder, and its
 *  menu to hide, delete or add the property to a type. Every gesture writes
 *  once, when it ends. */
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref } from 'react'
import { ChevronDown } from 'lucide-react'
import { DividerHandle, type DividerDrag } from '@/components/DividerHandle'
import { PropertyPicker } from '@/components/propertyPanel/PropertyPicker'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Block } from '@/data/block'
import { adoptOrCreatePropertySchema } from '@/data/propertySchemaCreation'
import { NO_BLOCK_GESTURES_ATTRIBUTE } from '@/extensions/continuousGestures'
import { useModalShadowing } from '@/shortcuts/useActionContext'
import { showInfo } from '@/utils/toast'
import {
  addColumn, addColumnForChoice, addPropertyToType, clearColumnWidth, columnWidthFor, deleteColumn, moveColumn,
  resizeColumn, setColumnHidden, typeTargetsFor, type ColumnDeletion, type TypeTarget,
} from './columns'
import { rowPropertyNames, type TableColumn } from './model'
import type { QueryClauses } from './query/parse'
import { nextSort, type ViewSort } from './sort'

/** A pointer that travels less than this is a click, not a drag. */
const DRAG_THRESHOLD = 5

/** A finger needs a wider strip than a mouse. */
const RESIZE_HANDLE_WIDTH = 16

/** Header gestures are not the table block's: its own clicks and swipes stay out. */
const headerSurface = {[NO_BLOCK_GESTURES_ATTRIBUTE]: 'true', 'data-block-interaction': 'ignore'}

/** Report a failed write; the gesture itself has already ended. */
const report = (what: string) => (error: unknown) => { console.error(`[tables] ${what} failed`, error) }

/** A column drawn at a width it does not store yet: a resize in progress, or
 *  released and still being written. */
export interface ResizePreview {
  readonly columnId: string
  readonly width: number
}

const headerCells = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(':scope > [role="columnheader"]')]

/** Where a dragged header would land: before the header at `slot`, or after
 *  the last one when `slot` is the header count. */
const dropSlot = (cells: readonly HTMLElement[], x: number): number => {
  const index = cells.findIndex(cell => {
    const box = cell.getBoundingClientRect()
    return x < box.left + box.width / 2
  })
  return index < 0 ? cells.length : index
}

const indicatorLeft = (cells: readonly HTMLElement[], row: HTMLElement, slot: number): number => {
  if (cells.length === 0) return 0
  const origin = row.getBoundingClientRect().left
  const edge = slot < cells.length ? cells[slot]!.getBoundingClientRect().left : cells[cells.length - 1]!.getBoundingClientRect().right
  return edge - origin - 1
}

/** The move a drop at `slot` makes, read from the headers drawn now, so a
 *  column list that changed during the drag cannot misplace it. Null where the
 *  column already is. */
const dropAnchor = (cells: readonly HTMLElement[], columnId: string, slot: number) => {
  const ids = cells.map(cell => cell.getAttribute('data-table-column')!)
  const from = ids.indexOf(columnId)
  if (from < 0 || slot === from || slot === from + 1) return null
  return slot < ids.length
    ? {side: 'before' as const, columnId: ids[slot]!}
    : {side: 'after' as const, columnId: ids[ids.length - 1]!}
}

interface HeaderProps {
  host: Block
  workspaceId: string
  columns: readonly TableColumn[]
  names: readonly string[]
  template: CSSProperties
  scrollRef: Ref<HTMLDivElement>
  /** DOM focus moved into the header, which may have scrolled it on its own. */
  onFocus: () => void
  rowIds: readonly string[]
  editable: boolean
  onResizePreview: (preview: ResizePreview | null) => void
  sort: ViewSort | undefined
  /** Per column: does its property sort in SQL? */
  sortable: readonly boolean[]
  /** Writes the view's sort; undefined unsorts. */
  onSort: (sort: ViewSort | undefined) => void
}

const SORT_ARIA = {asc: 'ascending', desc: 'descending'} as const

export const ColumnHeaders = ({
  host, workspaceId, columns, names, template, scrollRef, onFocus, rowIds, editable, onResizePreview, sort, sortable, onSort,
}: HeaderProps) => {
  const rowRef = useRef<HTMLDivElement>(null)
  /** The dragged column and where its drop indicator stands, in px from the row's left edge. */
  const [drag, setDrag] = useState<{columnId: string; indicator: number} | null>(null)
  /** A press on a header label: it becomes a reorder once it travels. */
  const press = useRef<{pointerId: number; x: number; columnId: string; slot: number | null} | null>(null)

  /** Drag a header to reorder. The label captures the pointer, so a pointer
   *  that leaves it is still followed, and nothing outlives the header. */
  const reorder = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>, columnId: string) => {
      if (!editable || event.button !== 0) return
      // No text selection under a drag.
      event.preventDefault()
      press.current = {pointerId: event.pointerId, x: event.clientX, columnId, slot: null}
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = press.current
      const row = rowRef.current
      if (!current || current.pointerId !== event.pointerId || !row) return
      if (current.slot === null && Math.abs(event.clientX - current.x) < DRAG_THRESHOLD) return
      const cells = headerCells(row)
      current.slot = dropSlot(cells, event.clientX)
      setDrag({columnId: current.columnId, indicator: indicatorLeft(cells, row, current.slot)})
    },
    end: (event: ReactPointerEvent<HTMLElement>, drop: boolean) => {
      const current = press.current
      if (!current || current.pointerId !== event.pointerId) return
      press.current = null
      setDrag(null)
      const row = rowRef.current
      // A press that never travelled is a click: it sorts.
      if (drop && current.slot === null) {
        if (sortable[columns.findIndex(column => column.id === current.columnId)]) onSort(nextSort(sort, current.columnId))
        return
      }
      if (!drop || current.slot === null || !row) return
      const anchor = dropAnchor(headerCells(row), current.columnId, current.slot)
      if (anchor) void moveColumn(host.repo, current.columnId, anchor).catch(report('column move'))
    },
  }

  return (
    <div ref={scrollRef} onFocus={onFocus} {...headerSurface}
      className="sticky top-0 z-[2] overflow-hidden border-b border-border bg-background">
      <div ref={rowRef} role="row" className={`relative grid text-sm font-medium ${ROW_BULLET_GUTTER}`} style={template}>
        {columns.map((column, index) => (
          <div key={column.id} role="columnheader" data-table-column={column.id}
            aria-sort={sort?.columnId === column.id ? SORT_ARIA[sort.direction] : undefined}
            // The frozen header sits above the other columns' resize strips (z-20).
            className={`group relative flex min-w-0 items-center border-r border-border ${index === 0 ? 'sticky left-0 z-30 bg-background' : ''} ${drag?.columnId === column.id ? 'opacity-50' : ''}`}>
            <span data-table-column-drag="true"
              className={`min-w-0 flex-1 truncate px-2 py-1 ${editable ? 'cursor-grab touch-pan-y select-none' : ''}`}
              onPointerDown={event => reorder.onPointerDown(event, column.id)}
              onPointerMove={reorder.onPointerMove}
              onPointerUp={event => reorder.end(event, true)}
              onPointerCancel={event => reorder.end(event, false)}
              onLostPointerCapture={event => reorder.end(event, false)}>
              {names[index]}
              {sort?.columnId === column.id && <span data-table-sort={sort.direction} aria-hidden="true"
                className="ml-1 text-muted-foreground">{sort.direction === 'asc' ? '↑' : '↓'}</span>}
            </span>
            {editable && <ColumnMenu host={host} workspaceId={workspaceId} column={column} name={names[index]!}
              rowIds={rowIds} sort={sortable[index] ? sort : null} onSort={onSort}/>}
            {editable && <ResizeHandle host={host} column={column} name={names[index]!} onPreview={onResizePreview}
              measure={() => rowRef.current?.querySelector(`:scope > [data-table-column="${CSS.escape(column.id)}"]`)
                ?.getBoundingClientRect().width}/>}
          </div>
        ))}
        {drag && <div data-table-drop-indicator="true" aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-[3] w-0.5 bg-ring" style={{left: drag.indicator}}/>}
      </div>
    </div>
  )
}

/** Drag a header's right edge. The width shows live and is written once, on
 *  release; a cancelled drag puts it back. Double-click returns the column to
 *  its automatic width. */
const ResizeHandle = ({host, column, name, onPreview, measure}: {
  host: Block
  column: TableColumn
  name: string
  onPreview: (preview: ResizePreview | null) => void
  /** The header's drawn width, where the drag starts from. */
  measure: () => number | undefined
}) => {
  const start = useRef<number | null>(null)
  const width = useRef<number | null>(null)
  const drag: DividerDrag = {
    onStart: () => {
      start.current = measure() ?? null
      width.current = null
      return start.current !== null
    },
    onMove: dx => {
      width.current = columnWidthFor(start.current! + dx)
      onPreview({columnId: column.id, width: width.current})
    },
    onEnd: () => {
      const next = width.current
      if (next === null || next === column.width) {
        onPreview(null)
        return
      }
      void resizeColumn(host.repo, column.id, next).catch(error => {
        onPreview(null)
        report('column resize')(error)
      })
    },
    onCancel: () => onPreview(null),
  }
  return <DividerHandle drag={drag} width={RESIZE_HANDLE_WIDTH}
    onReset={() => { if (column.width !== undefined) void clearColumnWidth(host.repo, column.id).catch(report('column width reset')) }}
    label={`Resize ${name}`} title="Drag to resize; double-click for automatic width"
    style={{top: 0, bottom: 0, right: -RESIZE_HANDLE_WIDTH / 2}}/>
}

/** Keys pressed in an open menu are the menu's: without this the row's own
 *  bindings, active from the row's app focus, would act on the cell too. */
const useMenuOpen = () => {
  const [open, setOpen] = useState(false)
  useModalShadowing(open)
  return [open, setOpen] as const
}

const refusalNotice = (result: ColumnDeletion) => {
  if (result === 'nested') showInfo('This column has blocks nested under it. Show the table as an outline to move or delete them.')
}

const ColumnMenu = ({host, workspaceId, column, name, rowIds, sort, onSort}: {
  host: Block; workspaceId: string; column: TableColumn; name: string; rowIds: readonly string[]
  /** The view's sort; null when this column cannot sort. */
  sort: ViewSort | undefined | null
  onSort: (sort: ViewSort | undefined) => void
}) => {
  const [types, setTypes] = useState<readonly TypeTarget[]>([])
  const [open, setOpen] = useMenuOpen()
  const fieldId = column.fieldId
  // Looked up afresh on every open: the rows' types and the type's
  // declaration may have changed since the last one.
  const openChange = (isOpen: boolean) => {
    setOpen(isOpen)
    setTypes([])
    if (!isOpen || fieldId === null) return
    void typeTargetsFor(host.repo, workspaceId, rowIds, fieldId).then(setTypes, report('type lookup'))
  }
  const repo = host.repo
  return (
    <DropdownMenu open={open} onOpenChange={openChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-table-column-menu={column.id} aria-label={`${name} column menu`}
          className="mr-1 shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100 group-hover:opacity-100">
          <ChevronDown className="h-3.5 w-3.5"/>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {sort !== null && <>
          <DropdownMenuItem onSelect={() => onSort({columnId: column.id, direction: 'asc'})}>Sort ascending</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSort({columnId: column.id, direction: 'desc'})}>Sort descending</DropdownMenuItem>
          {sort?.columnId === column.id && <DropdownMenuItem onSelect={() => onSort(undefined)}>Remove sort</DropdownMenuItem>}
          <DropdownMenuSeparator/>
        </>}
        <DropdownMenuItem onSelect={() => { void setColumnHidden(repo, column.id, true).catch(report('column hide')) }}>
          Hide column
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void deleteColumn(repo, column.id).then(refusalNotice, report('column delete')) }}>
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

/** Where a row's bullet stands (its 20px link and the frame's 4px gap, see
 *  `TableRowLayout`), so the header's columns line up with the rows'. A margin
 *  on the row, not padding on the scroller: a scroller's padding moves where
 *  the frozen first column sticks, and the rows' scroller has none. */
const ROW_BULLET_GUTTER = 'ml-6'

/** Below the grid: add a column, and show the hidden ones again. */
export const ColumnToolbar = ({host, workspaceId, query, viewId, columnNames, hidden, hiddenNames, hasContentColumn}: {
  host: Block
  workspaceId: string
  query: QueryClauses | null
  viewId: string
  /** The properties the view has columns for already, shown or hidden. */
  columnNames: readonly string[]
  hidden: readonly TableColumn[]
  hiddenNames: readonly string[]
  hasContentColumn: boolean
}) => {
  const [adding, setAdding] = useState(0)
  const [rowNames, setRowNames] = useState<readonly string[]>([])
  const loading = useRef(false)
  const startAdding = () => {
    if (loading.current) return
    loading.current = true
    // The picker opens once the rows' names are in, so its list does not reorder under the cursor.
    void rowPropertyNames(host, workspaceId, query)
      .catch(error => { console.error('[tables] row property names failed', error); return [] })
      .then(names => {
        loading.current = false
        setRowNames(names)
        setAdding(key => key + 1)
      })
  }
  const [hiddenOpen, setHiddenOpen] = useMenuOpen()
  const repo = host.repo
  const userSchemas = repo.userSchemas
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {adding > 0
        ? <div className="w-56" data-table-add-column-picker="true">
          <PropertyPicker key={adding} block={host} autoFocus placeholder="Column property"
            preferredNames={rowNames} excludedNames={columnNames}
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
          onClick={startAdding}>+ Add column</button>}
      {!hasContentColumn && <button type="button" className="px-2 py-1 hover:text-foreground"
        onClick={() => { void addColumn(repo, viewId, null).catch(report('add title column')) }}>+ Title column</button>}
      {hidden.length > 0 && (
        <DropdownMenu open={hiddenOpen} onOpenChange={setHiddenOpen}>
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
