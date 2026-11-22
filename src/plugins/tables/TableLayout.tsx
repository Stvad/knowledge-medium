import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode,
} from 'react'
import { BlockChildren, BlockComponent } from '@/components/BlockComponent'
import { LazyBlockComponent } from '@/components/LazyBlockComponent'
import { BlockFrame } from '@/components/renderer/DefaultBlockRenderer'
import { CollapsibleContent } from '@/components/ui/collapsible'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block'
import { PropertyDisplayScopeContext, PropertyFieldRowContext } from '@/context/propertyDisplay'
import { type AnyPropertySchema, type BlockData, type TypedBlockQuery } from '@/data/api'
import type { Block } from '@/data/block'
import { useIsActivePanel, useUIStateBlock } from '@/data/globalState'
import { isPropertyValueEditable } from '@/data/internals/propertyValueEdits'
import { focusedBlockLocationFromProperties, isEditingProp } from '@/data/properties'
import { safeDecodeRowProperty, storedPropertyValue } from '@/data/rowProperty'
import { NO_BLOCK_GESTURES_ATTRIBUTE } from '@/extensions/continuousGestures'
import type { BlockLayout } from '@/extensions/blockInteraction'
import { useContent, useHandle, useWorkspaceId } from '@/hooks/block'
import { isSingleValueProperty, resolveFieldDefinition, usePropertyDefinitions } from '@/plugins/property-rows/fieldRow'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { ActionContextTypes } from '@/shortcuts/types'
import { useActionContextActivations } from '@/shortcuts/useActionContext'
import { CELL_CONTROL_SELECTOR, GridController, type GridColumn } from './controller'
import { CELL_CONTEXT_KEY, GRID_CONTEXT_KEY, LIST_CONTEXT_KEY, ROW_CONTEXT_KEY, TABLE_ROW_CONTEXT, TABLE_TYPING_CONTEXT, controlKeyCommand } from './keys'
import { ColumnHeaders, ColumnToolbar, type ResizePreview } from './ColumnHeaders'
import { ROW_CAP, canAddRow, useColumns, useRowIds, useViewIds, type TableColumn } from './model'
import { AddQueryButton, OutsideQuery, QueryErrors, QueryFields, useEditingIn, useHeldWhile, useLiveRows } from './QueryUi'
import { useTableQuery, type TableQuery } from './query/source'
import { isSortable, sortOrder, useQueryableFieldNames, useViewSort, writeSort, type ViewSort } from './sort'
import { registerGrid, tableRenderScopeId } from './registry'

/** Spatial navigation skips cells: focus belongs on the row. */
export const CELL_SURFACE = 'tables.cell'

interface TableState {
  controller: GridController
  columns: readonly TableColumn[]
  schemas: readonly (AnyPropertySchema | undefined)[]
  editable: readonly boolean[]
  /** The first column that shows the row's own text, -1 for none. */
  contentColumn: number
  /** Rows made here that the query does not select. */
  unmatched: ReadonlySet<string>
}

/** Set on the grid's root from the columns' widths; header and rows read them. */
const TRACKS_VARIABLE = '--tables-tracks'
const MIN_WIDTH_VARIABLE = '--tables-min-width'
const GRID_TEMPLATE: CSSProperties = {
  gridTemplateColumns: `var(${TRACKS_VARIABLE})`,
  minWidth: `var(${MIN_WIDTH_VARIABLE})`,
}

const TableContext = createContext<TableState | null>(null)

/** The narrowest a column without a stored width gets; wider ones share the rest. */
const defaultMinWidth = (column: TableColumn) => column.fieldId === null ? 192 : 144

const columnTrack = (column: TableColumn) =>
  column.width !== undefined ? `${column.width}px`
    : `minmax(${defaultMinWidth(column)}px, ${column.fieldId === null ? 1.5 : 1}fr)`

const minWidth = (columns: readonly TableColumn[]) =>
  columns.reduce((sum, column) => sum + (column.width ?? defaultMinWidth(column)), 0)

const formatStored = (value: unknown): string =>
  value === undefined || value === null ? ''
    : Array.isArray(value) ? value.map(formatStored).join(', ')
    : typeof value === 'object' ? JSON.stringify(value)
    : String(value)

/** The value as `properties_json` stores it, for cells that draw no rows. */
const StoredValue = ({properties, schema}: {properties: BlockData['properties'] | undefined; schema: AnyPropertySchema}) => {
  const text = properties ? formatStored(storedPropertyValue(properties, schema.name)) : ''
  return text ? <span className="block truncate text-muted-foreground" title={text}>{text}</span> : null
}

const ReadOnlyCell = ({row, schema}: {row: Block; schema: AnyPropertySchema}) => {
  const properties = useHandle(row, {selector: data => data?.properties})
  return <StoredValue properties={properties} schema={schema}/>
}

/** The block context a cell draws its blocks in: rooted at `scopeRootId`, out
 *  of spatial navigation unless `outline`, with `::` off (it would turn a
 *  value itself into a field row), and the property its values belong to. */
const CellScope = ({scopeRootId, fieldRowId, schema, outline, children}: {
  scopeRootId: string; fieldRowId: string; schema: AnyPropertySchema; outline: boolean; children: ReactNode
}) => {
  const overrides = useMemo(() => outline
    ? {scopeRootId, disablePropertyFieldCompletion: true, disableBlockSplit: false, [LIST_CONTEXT_KEY]: true}
    : {scopeRootId, disablePropertyFieldCompletion: true, disableBlockSplit: true, surfaceName: CELL_SURFACE,
      [CELL_CONTEXT_KEY]: scopeRootId},
  [outline, scopeRootId])
  const field = useMemo(() => ({id: fieldRowId, schema}), [fieldRowId, schema])
  return (
    <NestedBlockContextProvider overrides={overrides}>
      <PropertyFieldRowContext value={field}>{children}</PropertyFieldRowContext>
    </NestedBlockContextProvider>
  )
}

const EditableCell = ({row, fieldId, schema}: {row: Block; fieldId: string; schema: AnyPropertySchema}) => {
  const cell = useHandle(row.repo.query.propertyRows({ownerId: row.id, fieldId}), {selector: rows => rows && {
    properties: rows.owner?.properties,
    fieldRowIds: rows.fields.filter(({values}) => values.length > 0).map(({field}) => field.id),
    values: rows.fields.flatMap(({field, values}) =>
      values.map(value => ({id: value.id, fieldRowId: field.id, hasChildren: value.hasChildren}))),
  }})
  if (!cell) return null
  const {values} = cell
  if (values.length === 0) return <StoredValue properties={cell.properties} schema={schema}/>
  // A list's members are drawn as the outline draws a field row's children:
  // bulleted blocks that split, merge, nest and show their own children. The
  // field row is their scope root and is not drawn (see `./keys`).
  if (!isSingleValueProperty(schema)) return (
    <div data-table-list="true" className="min-w-0">
      {cell.fieldRowIds.map(id => <CellScope key={id} scopeRootId={id} fieldRowId={id} schema={schema} outline>
        <BlockChildren block={row.repo.block(id)}/>
      </CellScope>)}
    </div>
  )
  const nested = values.some(value => value.hasChildren)
  return (
    <div className="flex min-w-0 flex-col">
      {/* Each value is the root of its own scope, so structural edits cannot move it out of the cell. */}
      {values.map(value =>
        <CellScope key={value.id} scopeRootId={value.id} fieldRowId={value.fieldRowId} schema={schema} outline={false}>
          <BlockComponent blockId={value.id}/>
        </CellScope>)}
      {nested && <span data-table-nested="true" className="text-xs text-muted-foreground"
        title="This value has nested blocks. Show the table as an outline to see them.">…</span>}
    </div>
  )
}

const isInteractive = (target: EventTarget) =>
  target instanceof Element && target.closest('input, select, button, textarea, a, .cm-editor') !== null

/** A list's members are blocks: a click on one is the block's own. Only this
 *  cell's list counts, not one of an outer table the cell is drawn inside. */
const inOwnList = (target: EventTarget, cell: Element) => {
  const list = target instanceof Element ? target.closest('[data-table-list]') : null
  return list !== null && list.closest('[data-table-col]') === cell
}

const isPlainKey = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey

const Cell = ({row, index, sticky, isContent, children}: {
  row: Block; index: number; sticky: boolean; isContent: boolean; children: ReactNode
}) => {
  const {controller} = useContext(TableContext)!
  const click = (event: MouseEvent<HTMLDivElement>) => {
    // Controls, links and editors keep their click; so does the row's own
    // text, which edits in place.
    if (isContent || isInteractive(event.target) || inOwnList(event.target, event.currentTarget)) {
      controller.setColumn(index)
      return
    }
    event.stopPropagation()
    event.preventDefault()
    controller.focusCell(row.id, index, event.detail === 2)
  }
  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches(CELL_CONTROL_SELECTOR)) {
      controller.controlFocused(row.id, index, event.target)
    }
  }
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement) controller.controlBlurred(event.target)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(CELL_CONTROL_SELECTOR)) return
    if (event.nativeEvent.isComposing) return
    const command = controlKeyCommand(event)
    if (command) {
      event.preventDefault()
      event.stopPropagation()
      controller.command(command)
      return
    }
    // A plain key on a control is the control's: a checkbox is a button, so no
    // modal context shadows the row's bindings (vim's Delete would remove the row).
    // Chords still reach the app.
    if (isPlainKey(event)) event.stopPropagation()
  }
  return (
    <div
      data-table-col={index}
      className={`min-w-0 border-r border-border px-2 py-0.5 ${sticky ? 'sticky left-0 z-[1] bg-background' : ''}`}
      onClickCapture={click}
      onFocus={focus}
      onBlur={blur}
      onKeyDown={keyDown}
    >
      {children}
    </div>
  )
}

const RowText = ({row}: {row: Block}) => {
  const content = useContent(row)
  return <span className="block truncate">{content}</span>
}

const ValueCellBody = ({row, column, schema, editable}: {
  row: Block; column: TableColumn; schema: AnyPropertySchema | undefined; editable: boolean
}) => {
  if (!schema) return <span data-table-error="true" title="This column’s property cannot be found.">⚠</span>
  if (!editable) return <ReadOnlyCell row={row} schema={schema}/>
  return <EditableCell row={row} fieldId={column.fieldId!} schema={schema}/>
}

const UNMATCHED_TITLE = 'Not selected by the query. It stays here while the table is open.'

/** A row keeps its bullet, so it opens, opens in the sidebar and has its menu
 *  as any block does; no expand control, since the grid draws no children.
 *  The header's `ROW_BULLET_GUTTER` matches the bullet's width. */
const TableRowLayout: BlockLayout = ({block, Header, Shell, Bullet, Content}) => {
  const {columns, schemas, editable, contentColumn, unmatched} = useContext(TableContext)!
  const outside = unmatched.has(block.id)
  return (
    <BlockFrame
      block={block} Header={Header} Shell={Shell} Controls={Bullet}
      className={outside ? 'tm-table-row opacity-60' : 'tm-table-row'}
      frameProps={{'data-table-row': block.id, ...(outside ? {'data-table-unmatched': 'true', title: UNMATCHED_TITLE} : {})}}
    >
      {/* `.block-body` clips horizontal overflow: it must be as wide as the
          grid, so the overflow reaches the table's scroller. */}
      <div className="block-body grow" style={{minWidth: GRID_TEMPLATE.minWidth}}>
        {/* The border is on the grid, not the frame: the frame is only as wide
            as the scroller, so a border there stops short once it scrolls. */}
        <div className="grid border-b border-border" style={GRID_TEMPLATE}>
          {columns.map((column, index) => (
            <Cell key={column.id} row={block} index={index} sticky={index === 0} isContent={index === contentColumn}>
              {column.fieldId === null
                ? index === contentColumn ? <Content/> : <RowText row={block}/>
                : <ValueCellBody row={block} column={column} schema={schemas[index]} editable={editable[index]!}/>}
            </Cell>
          ))}
        </div>
      </div>
    </BlockFrame>
  )
}

const TableCellLayout: BlockLayout = ({Shell, Content}) => (
  <Shell>{shellProps => (
    <div {...shellProps} tabIndex={-1} data-table-value="true" className={`min-w-0 ${shellProps.className ?? ''}`}>
      <Content/>
    </div>
  )}</Shell>
)

const CursorStyle = ({gridId, controller}: {gridId: string; controller: GridController}) => {
  const column = useSyncExternalStore(controller.subscribeColumn, () => controller.currentColumn)
  return <style>{`[data-table-grid="${CSS.escape(gridId)}"] [data-table-row]:focus-within [data-table-col="${column}"] {
  box-shadow: inset 0 0 0 2px var(--color-ring, currentColor);
}`}</style>
}

/** Row mode, activated from focus state rather than by the row's shell, so
 *  keys keep working while the row focus moved to mounts. The row a focus
 *  write is still committing to counts as focused. Typing opens a cell only
 *  while vim's normal mode is off: there the same keys are vim's. */
const RowKeys = ({controller, rows, renderScopeId}: {
  controller: GridController; rows: ReadonlySet<string>; renderScopeId: string
}) => {
  const uiStateBlock = useUIStateBlock()
  const focus = useHandle(uiStateBlock, {selector: data => {
    const location = focusedBlockLocationFromProperties(data?.properties)
    return location?.renderScopeId === renderScopeId
      ? {blockId: location.blockId, editing: data ? safeDecodeRowProperty(data, isEditingProp) : false}
      : null
  }})
  const pending = useSyncExternalStore(controller.subscribePending, controller.getPendingRow)
  const inControl = useSyncExternalStore(controller.subscribeControl, controller.isInControl)
  const normalMode = useActiveContextsState().has(ActionContextTypes.NORMAL_MODE)
  const panelActive = useIsActivePanel(uiStateBlock)
  const rowId = pending ?? focus?.blockId
  const onRow = panelActive && !inControl && rowId !== undefined && rows.has(rowId) && (pending !== null || !focus?.editing)
  const dependencies = useMemo(() => ({gridCommand: controller.command}), [controller])
  // Stable, or every render would release and re-claim the contexts.
  const activations = useMemo(() => !onRow ? []
    : normalMode ? [{context: TABLE_ROW_CONTEXT, dependencies}]
    : [{context: TABLE_ROW_CONTEXT, dependencies}, {context: TABLE_TYPING_CONTEXT, dependencies}],
  [dependencies, normalMode, onRow])
  useActionContextActivations(activations)
  return null
}

/** Hands focus that an outline verb put on a cell's undrawn field row to its row. */
const FieldRowFocusGuard = ({controller, renderScopeId}: {controller: GridController; renderScopeId: string}) => {
  const focusedId = useHandle(useUIStateBlock(), {selector: data => {
    const location = focusedBlockLocationFromProperties(data?.properties)
    return location?.renderScopeId === renderScopeId ? location.blockId : undefined
  }})
  useEffect(() => { if (focusedId) controller.leaveFieldRow(focusedId) }, [controller, focusedId])
  return null
}

interface GridProps {
  host: Block
  renderScopeId: string
  parentRenderScopeId: string
  workspaceId: string
}

/** Nothing is drawn until the view and its columns have loaded, so a table
 *  never flashes as empty. */
const TableGrid = (props: GridProps) => {
  const viewIds = useViewIds(props.host, props.workspaceId)
  const query = useTableQuery(props.host, props.workspaceId)
  if (viewIds === undefined || query === undefined) return null
  if (viewIds.length === 0) return <p className="py-1 text-sm text-muted-foreground">
    This table has no view. Show it as an outline and turn it into a table again to add one.
  </p>
  return <TableView {...props} viewIds={viewIds} query={query}/>
}

const NO_COLUMNS: readonly TableColumn[] = []
const NO_ROWS: readonly string[] = []
const NO_UNMATCHED: ReadonlySet<string> = new Set()

/** What each column shows: its property definition, and its header name. */
const useColumnDefinitions = (repo: Block['repo'], workspaceId: string, columns: readonly TableColumn[]) => {
  const definitions = usePropertyDefinitions(repo)
  const definitionsOf = useMemo(() => columns.map(column => column.fieldId === null ? undefined
    : resolveFieldDefinition(repo, definitions, workspaceId, column.fieldId)), [columns, definitions, repo, workspaceId])
  const names = useMemo(() => columns.map((column, index) => column.label ||
    (column.fieldId === null ? 'Title' : definitionsOf[index]?.name ?? 'Unknown property')), [columns, definitionsOf])
  const schemas = useMemo(() => definitionsOf.map(definition => definition?.schema), [definitionsOf])
  return {schemas, names}
}

type ColumnSchema = AnyPropertySchema | undefined

/** Hidden columns are drawn nowhere but in the toolbar, which shows them again. */
const TableView = (props: GridProps & {viewIds: readonly string[]; query: TableQuery | null}) => {
  const viewId = props.viewIds[0]!
  const all = useColumns(props.host, props.workspaceId, viewId)
  const {schemas, names} = useColumnDefinitions(props.host.repo, props.workspaceId, all ?? NO_COLUMNS)
  const sort = useViewSort(props.host.repo.block(viewId))
  const fieldNames = useQueryableFieldNames(props.host.repo, props.workspaceId)
  const order = useMemo(() => sortOrder(sort, all ?? NO_COLUMNS, schemas, fieldNames), [all, fieldNames, schemas, sort])
  const split = useMemo(() => {
    const shown = {columns: [] as TableColumn[], schemas: [] as ColumnSchema[], names: [] as string[]}
    const hidden = {columns: [] as TableColumn[], names: [] as string[]}
    ;(all ?? NO_COLUMNS).forEach((column, index) => {
      if (column.hidden) {
        hidden.columns.push(column)
        hidden.names.push(names[index]!)
      } else {
        shown.columns.push(column)
        shown.schemas.push(schemas[index])
        shown.names.push(names[index]!)
      }
    })
    return {shown, hidden}
  }, [all, schemas, names])
  const columnNames = useMemo(() => schemas.flatMap(schema => schema ? [schema.name] : []), [schemas])
  if (all === undefined) return null
  const toolbar = props.host.repo.isReadOnly ? null : <ColumnToolbar host={props.host} viewId={viewId}
    workspaceId={props.workspaceId} query={props.query?.clauses ?? null}
    columnNames={columnNames}
    hidden={split.hidden.columns} hiddenNames={split.hidden.names}
    hasContentColumn={all.some(column => column.fieldId === null)}/>
  if (split.shown.columns.length === 0) return <><NoColumns/>{toolbar}</>
  return <TableBody {...props} columns={split.shown.columns} schemas={split.shown.schemas}
    names={split.shown.names} toolbar={toolbar} viewId={viewId} sort={sort} order={order}/>
}

const NoColumns = () => <p className="py-1 text-sm text-muted-foreground">This table shows no columns.</p>

const TableBody = ({
  host, renderScopeId, parentRenderScopeId, workspaceId, query, columns, schemas, names, toolbar, viewId, viewIds, sort, order,
}: GridProps & {
  query: TableQuery | null
  viewIds: readonly string[]
  columns: readonly TableColumn[]
  schemas: readonly ColumnSchema[]
  names: readonly string[]
  toolbar: ReactNode
  viewId: string
  sort: ViewSort | undefined
  order: TypedBlockQuery['order'] | undefined
}) => {
  const uiStateBlock = useUIStateBlock()
  const repo = host.repo
  const [controller] = useState(() => new GridController(host, uiStateBlock, renderScopeId, parentRenderScopeId))
  const gridId = useId()
  const {childBacked} = useContext(PropertyDisplayScopeContext)
  const selected = useRowIds(host, workspaceId, query?.clauses ?? null, order)
  const liveCreated = useLiveRows(repo, useSyncExternalStore(controller.subscribeCreated, controller.getCreated))
  const created = query ? liveCreated : NO_ROWS
  // While a cell or row is being edited the query's answer is held, so an edit
  // that stops a row matching does not pull it out from under the editor.
  const editing = useEditingIn(uiStateBlock, renderScopeId)
  const held = useHeldWhile(selected, query !== null && editing)
  const rowIds = useMemo(() => {
    if (!held || created.length === 0) return held
    const listed = new Set(held)
    return [...held, ...created.filter(id => !listed.has(id))]
  }, [created, held])
  const unmatched = useMemo(() => {
    if (created.length === 0) return NO_UNMATCHED
    const live = new Set(selected ?? [])
    return new Set(created.filter(id => !live.has(id)))
  }, [created, selected])
  const shown = useMemo(() => rowIds?.slice(0, ROW_CAP) ?? [], [rowIds])
  const editable = useMemo(() => columns.map((column, index) => !repo.isReadOnly &&
    (column.fieldId === null || (childBacked && isPropertyValueEditable(schemas[index])))),
  [childBacked, columns, repo.isReadOnly, schemas])
  const gridColumns = useMemo<GridColumn[]>(() => columns.map((column, index) => ({
    id: column.id,
    fieldId: column.fieldId,
    editable: editable[index]!,
    list: schemas[index] !== undefined && !isSingleValueProperty(schemas[index]),
  })), [columns, editable, schemas])

  useLayoutEffect(() => { if (rowIds) controller.setRows(shown, rowIds.length) }, [controller, rowIds, shown])
  useLayoutEffect(() => { controller.setQuery(query?.parsed.terms ?? null) }, [controller, query])
  useLayoutEffect(() => { controller.setColumns(gridColumns) }, [controller, gridColumns])
  useLayoutEffect(() => registerGrid(renderScopeId, controller), [controller, renderScopeId])

  const rowSet = useMemo(() => new Set(shown), [shown])
  // A resize shows live and is stored once, when the drag ends. The preview
  // stays until the stored width arrives, so the column never jumps back to
  // its old width for the length of the write.
  const [resizing, setResizing] = useState<ResizePreview | null>(null)
  if (resizing && columns.find(column => column.id === resizing.columnId)?.width === resizing.width) {
    setResizing(null)
  }
  const laidOut = useMemo(() => resizing === null ? columns
    : columns.map(column => column.id === resizing.columnId ? {...column, width: resizing.width} : column),
  [columns, resizing])
  // The tracks reach the rows as CSS variables, so a resize restyles the root
  // and re-renders no row.
  const tracks = useMemo(() => ({
    [TRACKS_VARIABLE]: laidOut.map(columnTrack).join(' '),
    [MIN_WIDTH_VARIABLE]: `${minWidth(laidOut)}px`,
  }) as CSSProperties, [laidOut])
  // The rows' scroller drives the header. The header also scrolls on its own
  // when a control in it takes focus; that one scroll is copied back.
  const header = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const syncHeader = (event: React.UIEvent<HTMLDivElement>) => {
    if (header.current) header.current.scrollLeft = event.currentTarget.scrollLeft
  }
  const headerFocused = () => requestAnimationFrame(() => {
    if (header.current && scroller.current) scroller.current.scrollLeft = header.current.scrollLeft
  })
  const rootRef = useCallback((element: HTMLDivElement | null) => { controller.setRoot(element) }, [controller])
  const contentColumn = columns.findIndex(column => column.fieldId === null)
  const table = useMemo<TableState>(() => ({controller, columns, schemas, editable, contentColumn, unmatched}),
    [controller, columns, schemas, editable, contentColumn, unmatched])
  const fieldNames = useQueryableFieldNames(repo, workspaceId)
  const sortable = useMemo(() => schemas.map(schema => isSortable(schema, fieldNames)), [fieldNames, schemas])
  const onSort = useCallback((next: ViewSort | undefined) => {
    void writeSort(repo, viewId, next).catch(error => console.error('[tables] sort failed', error))
  }, [repo, viewId])
  const rowsOverrides = useMemo(() => ({
    isNestedSurface: true, layoutBoundary: false, renderScopeId,
    [GRID_CONTEXT_KEY]: controller,
  }), [controller, renderScopeId])

  return (
    <div ref={rootRef} data-table-grid={gridId} className="my-1 text-sm" style={tracks}>
      <CursorStyle gridId={gridId} controller={controller}/>
      <RowKeys controller={controller} rows={rowSet} renderScopeId={renderScopeId}/>
      <FieldRowFocusGuard controller={controller} renderScopeId={renderScopeId}/>
      {!childBacked && <p className="py-1 text-xs text-muted-foreground">
        Read-only: this workspace stores properties in the block, not as rows.
      </p>}
      {query && <QueryErrors query={query}/>}
      <ColumnHeaders host={host} workspaceId={workspaceId} columns={columns} names={names} template={GRID_TEMPLATE}
        scrollRef={header} onFocus={headerFocused} rowIds={shown} editable={!repo.isReadOnly} onResizePreview={setResizing}
        sort={sort} sortable={sortable} onSort={onSort}/>
      {/* The gesture marker sits on the scroller: horizontal touch panning
          needs the marked element to be the one that scrolls. */}
      <div ref={scroller} data-table-scroller="true" {...{[NO_BLOCK_GESTURES_ATTRIBUTE]: 'true'}}
        className="overflow-x-auto overflow-y-hidden" onScroll={syncHeader}>
        <TableContext value={table}>
          <NestedBlockContextProvider overrides={rowsOverrides}>
            {shown.map(id => <TableRow key={id} id={id} renderScopeId={renderScopeId}/>)}
          </NestedBlockContextProvider>
        </TableContext>
      </div>
      {rowIds && rowIds.length > ROW_CAP && <p className="py-1 text-xs text-muted-foreground">
        Showing the first {ROW_CAP} rows.{query ? ' Narrow the query to see the rest.' : ''}
      </p>}
      <div className="flex flex-wrap items-center">
        {!repo.isReadOnly && rowIds && canAddRow(rowIds.length) &&
          <button type="button" className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => { void controller.appendRow() }}>+ New row</button>}
        {!repo.isReadOnly && !query && childBacked && <AddQueryButton host={host} parentRenderScopeId={parentRenderScopeId}/>}
        {toolbar}
      </div>
      {query && <OutsideQuery host={host} viewIds={viewIds} rows={shown}/>}
    </div>
  )
}

/** Each row is the root of its own scope. The outline's indent, outdent,
 *  merge and vertical move would otherwise carry it into a subtree the grid
 *  never draws, or fold the first row into the view block; at a scope root the
 *  structural policy refuses them. Split would make a hidden first child there,
 *  so it is refused too. Deleting a row stays allowed. */
const TableRow = ({id, renderScopeId}: {id: string; renderScopeId: string}) => {
  const overrides = useMemo(() => ({[ROW_CONTEXT_KEY]: id, scopeRootId: id, disableBlockSplit: true}), [id])
  return (
    <NestedBlockContextProvider overrides={overrides}>
      <LazyBlockComponent blockId={id} renderScopeId={renderScopeId}/>
    </NestedBlockContextProvider>
  )
}

const TableHostLayout: BlockLayout = ({block, Header, Shell, Controls, Content, Properties, BelowContent, Footer}) => {
  const workspaceId = useWorkspaceId(block)
  const parentRenderScopeId = useBlockContext().renderScopeId ?? ''
  const renderScopeId = tableRenderScopeId(parentRenderScopeId, block.id)
  return (
    <BlockFrame block={block} Header={Header} Shell={Shell} Controls={Controls} className="tm-table-host">
      <div className="block-body min-w-0 grow">
        <Content/>
        {Properties && <Properties/>}
        <BelowContent/>
        {/* The grid stands where the children would, so it collapses with them. */}
        <CollapsibleContent>
          <QueryFields host={block}/>
          {workspaceId && <TableGrid key={renderScopeId} host={block} renderScopeId={renderScopeId}
            parentRenderScopeId={parentRenderScopeId} workspaceId={workspaceId}/>}
        </CollapsibleContent>
        <Footer/>
      </div>
    </BlockFrame>
  )
}

export { TableCellLayout, TableHostLayout, TableRowLayout }
