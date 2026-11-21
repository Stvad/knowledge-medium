import {
  createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode,
} from 'react'
import { BlockComponent } from '@/components/BlockComponent'
import { LazyBlockComponent } from '@/components/LazyBlockComponent'
import { BlockFrame } from '@/components/renderer/DefaultBlockRenderer'
import { FocusedRowLazyMount } from '@/components/util/FocusedRowLazyMount'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block'
import { PropertyDisplayScopeContext, PropertyFieldRowContext } from '@/context/propertyDisplay'
import type { AnyPropertySchema, BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { useIsActivePanel, useUIStateBlock } from '@/data/globalState'
import { isPropertyValueEditable } from '@/data/internals/propertyValueEdits'
import { focusedBlockLocationFromProperties, isEditingProp } from '@/data/properties'
import { safeDecodeRowProperty, storedPropertyValue } from '@/data/rowProperty'
import { NO_BLOCK_GESTURES_ATTRIBUTE } from '@/extensions/continuousGestures'
import type { BlockLayout } from '@/extensions/blockInteraction'
import { useContent, useHandle } from '@/hooks/block'
import { usePropertyDefinitions } from '@/plugins/property-rows/fieldRow'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { ActionContextTypes } from '@/shortcuts/types'
import { useActionContextActivations } from '@/shortcuts/useActionContext'
import { surfaceRenderScopeId } from '@/utils/renderScope'
import { TABLE_SURFACE } from './cellEdits'
import { CELL_CONTROL_SELECTOR, GridController } from './controller'
import { CELL_CONTEXT_KEY, GRID_CONTEXT_KEY, ROW_CONTEXT_KEY, TABLE_ROW_CONTEXT, TABLE_TYPING_CONTEXT, controlKeyCommand } from './keys'
import { ROW_CAP, useColumns, useRowIds, useViewIds, type TableColumn } from './model'
import { registerGrid } from './registry'

/** Spatial navigation skips cells: focus belongs on the row. */
export const CELL_SURFACE = 'tables.cell'

interface TableState {
  controller: GridController
  columns: readonly TableColumn[]
  schemas: readonly (AnyPropertySchema | undefined)[]
  editable: readonly boolean[]
  template: CSSProperties
}

const TableContext = createContext<TableState | null>(null)

/** The narrowest a column without a stored width gets; wider ones share the rest. */
const defaultMinWidth = (column: TableColumn) => column.fieldId === null ? 192 : 144

const columnTrack = (column: TableColumn) =>
  column.width !== undefined ? `${column.width}px`
    : `minmax(${defaultMinWidth(column)}px, ${column.fieldId === null ? 1.5 : 1}fr)`

const minWidth = (columns: readonly TableColumn[]) =>
  columns.reduce((sum, column) => sum + (column.width ?? defaultMinWidth(column)), 0)

const NoControls = () => null

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

/** One value row, mounted as the root of its own scope so structural edits
 *  cannot move it out of the cell. */
const CellValue = ({valueId, fieldRowId, schema}: {valueId: string; fieldRowId: string; schema: AnyPropertySchema}) => {
  const overrides = useMemo(() => ({
    scopeRootId: valueId,
    surfaceName: CELL_SURFACE,
    disablePropertyFieldCompletion: true,
    disableBlockSplit: true,
    [CELL_CONTEXT_KEY]: true,
  }), [valueId])
  const field = useMemo(() => ({id: fieldRowId, schema}), [fieldRowId, schema])
  return (
    <NestedBlockContextProvider overrides={overrides}>
      <PropertyFieldRowContext value={field}>
        <BlockComponent blockId={valueId}/>
      </PropertyFieldRowContext>
    </NestedBlockContextProvider>
  )
}

const EditableCell = ({row, fieldId, schema}: {row: Block; fieldId: string; schema: AnyPropertySchema}) => {
  const cell = useHandle(row.repo.query.propertyRows({ownerId: row.id, fieldId}), {selector: rows => rows && {
    properties: rows.owner?.properties,
    values: rows.fields.flatMap(({field, values}) =>
      values.map(value => ({id: value.id, fieldRowId: field.id, hasChildren: value.hasChildren}))),
  }})
  if (!cell) return null
  const {values} = cell
  if (values.length === 0) return <StoredValue properties={cell.properties} schema={schema}/>
  const nested = values.some(value => value.hasChildren)
  return (
    <div className="flex min-w-0 flex-col">
      {values.map(value =>
        <CellValue key={value.id} valueId={value.id} fieldRowId={value.fieldRowId} schema={schema}/>)}
      {nested && <span data-table-nested="true" className="text-xs text-muted-foreground"
        title="This value has nested blocks. Show the table as an outline to see them.">…</span>}
    </div>
  )
}

const isInteractive = (target: EventTarget) =>
  target instanceof Element && target.closest('input, select, button, textarea, a, .cm-editor') !== null

const Cell = ({row, index, children, sticky}: {row: Block; index: number; children: ReactNode; sticky?: boolean}) => {
  const {controller} = useContext(TableContext)!
  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (isInteractive(event.target)) {
      controller.setColumn(index)
      return
    }
    if (sticky) {
      // The row's own text keeps its native click: it edits in place.
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
    if (!command) return
    event.preventDefault()
    event.stopPropagation()
    controller.command(command)
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

const TableRowLayout: BlockLayout = ({block, Header, Shell, Content}) => {
  const {columns, schemas, editable, template} = useContext(TableContext)!
  const contentColumn = columns.findIndex(column => column.fieldId === null)
  return (
    <BlockFrame
      block={block} Header={Header} Shell={Shell} Controls={NoControls}
      className="tm-table-row border-b border-border"
      frameProps={{'data-table-row': block.id}}
    >
      <div className="block-body min-w-0 grow">
        <div className="grid" style={template}>
          {columns.map((column, index) => (
            <Cell key={column.id} row={block} index={index} sticky={index === 0}>
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

const useColumnCursor = (controller: GridController) =>
  useSyncExternalStore(controller.subscribeColumn, () => controller.currentColumn)

const CursorStyle = ({gridId, controller}: {gridId: string; controller: GridController}) => {
  const column = useColumnCursor(controller)
  const grid = `[data-table-grid="${CSS.escape(gridId)}"]`
  return <style>{`${grid} [data-table-row]:focus-within [data-table-col="${column}"],
${grid} [data-table-row]:focus [data-table-col="${column}"] {
  box-shadow: inset 0 0 0 2px var(--color-ring, currentColor);
}`}</style>
}

const ColumnHeaders = ({repo, columns, schemas, template, scrollRef}: {
  repo: Repo
  columns: readonly TableColumn[]
  schemas: readonly (AnyPropertySchema | undefined)[]
  template: CSSProperties
  scrollRef: (element: HTMLDivElement | null) => void
}) => {
  const definitions = usePropertyDefinitions(repo)
  return (
    <div ref={scrollRef} className="sticky top-0 z-[2] overflow-hidden border-b border-border bg-background">
      <div role="row" className="grid text-sm font-medium" style={template}>
        {columns.map((column, index) => {
          const name = column.label || (column.fieldId === null ? 'Title'
            : schemas[index]?.name ?? definitions?.definitionsByFieldId.get(column.fieldId)?.name ?? 'Unknown property')
          return (
            <div key={column.id} role="columnheader"
              className={`truncate border-r border-border px-2 py-1 ${index === 0 ? 'sticky left-0 z-[1] bg-background' : ''}`}>
              {name}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Row mode, activated from focus state rather than by the
 *  row's shell, so keys keep working while the row focus moved to mounts.
 *  The row a focus write is still committing to counts as focused. */
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
  const panelActive = useIsActivePanel(uiStateBlock)
  const rowId = pending ?? focus?.blockId
  const onRow = panelActive && rowId !== undefined && rows.has(rowId) && (pending !== null || !focus?.editing)
  const dependencies = useMemo(() => ({gridCommand: controller.run, normalModeActive: controller.isNormalModeActive}), [controller])
  useActionContextActivations(!inControl && onRow
    ? [{context: TABLE_ROW_CONTEXT, dependencies}, {context: TABLE_TYPING_CONTEXT, dependencies}]
    : [])
  return null
}

/** Its own component so a context change re-renders only this. */
const NormalModeProbe = ({controller}: {controller: GridController}) => {
  const active = useActiveContextsState()
  useLayoutEffect(() => { controller.setNormalMode(active.has(ActionContextTypes.NORMAL_MODE)) }, [active, controller])
  return null
}

const TableGrid = ({host, renderScopeId, workspaceId}: {host: Block; renderScopeId: string; workspaceId: string}) => {
  const uiStateBlock = useUIStateBlock()
  const repo = host.repo
  const [controller] = useState(() => new GridController(host, uiStateBlock, renderScopeId))
  const gridId = useId()
  const {childBacked} = useContext(PropertyDisplayScopeContext)
  const definitions = usePropertyDefinitions(repo)
  const viewIds = useViewIds(host, workspaceId)
  const columns = useColumns(host, workspaceId, viewIds[0])
  const rowIds = useRowIds(host, workspaceId, viewIds)
  const shown = useMemo(() => rowIds?.slice(0, ROW_CAP) ?? [], [rowIds])
  const schemas = useMemo(() => {
    void definitions
    const resolver = repo.propertySchemaResolverFor(workspaceId)
    return columns.map(column => {
      if (column.fieldId === null) return undefined
      const resolution = resolver.resolveField(column.fieldId)
      return resolution.status === 'resolved' ? resolution.schema : undefined
    })
  }, [columns, definitions, repo, workspaceId])
  const editable = useMemo(() => columns.map((column, index) => !repo.isReadOnly &&
    (column.fieldId === null || (childBacked && isPropertyValueEditable(schemas[index])))),
  [childBacked, columns, repo.isReadOnly, schemas])

  useLayoutEffect(() => { controller.setRows(shown) }, [controller, shown])
  useLayoutEffect(() => { controller.setColumns(columns, editable) }, [controller, columns, editable])
  useLayoutEffect(() => registerGrid(renderScopeId, controller), [controller, renderScopeId])

  const rowSet = useMemo(() => new Set(shown), [shown])

  const template = useMemo<CSSProperties>(() => ({
    gridTemplateColumns: columns.map(columnTrack).join(' '),
    minWidth: `${minWidth(columns)}px`,
  }), [columns])
  const header = useRef<HTMLDivElement | null>(null)
  const syncHeader = (event: React.UIEvent<HTMLDivElement>) => {
    if (header.current) header.current.scrollLeft = event.currentTarget.scrollLeft
  }
  const rootRef = useCallback((element: HTMLDivElement | null) => { controller.setRoot(element) }, [controller])
  const table = useMemo<TableState>(() => ({controller, columns, schemas, editable, template}),
    [controller, columns, schemas, editable, template])
  const rowsOverrides = useMemo(() => ({
    isNestedSurface: true, layoutBoundary: false, scopeRootId: host.id, renderScopeId,
    [GRID_CONTEXT_KEY]: controller,
  }), [controller, host.id, renderScopeId])

  if (viewIds.length === 0 || columns.length === 0) {
    return <p className="py-1 text-sm text-muted-foreground">This table has no columns yet. Show it as an outline to add some.</p>
  }

  return (
    <div ref={rootRef} data-table-grid={gridId} className="my-1 text-sm">
      <CursorStyle gridId={gridId} controller={controller}/>
      <NormalModeProbe controller={controller}/>
      <RowKeys controller={controller} rows={rowSet} renderScopeId={renderScopeId}/>
      {!childBacked && <p className="py-1 text-xs text-muted-foreground">
        Read-only: this workspace stores properties in the block, not as rows.
      </p>}
      <ColumnHeaders repo={repo} columns={columns} schemas={schemas} template={template}
        scrollRef={element => { header.current = element }}/>
      {/* The gesture marker sits on the scroller: horizontal touch panning
          needs the marked element to be the one that scrolls. */}
      <div data-table-scroller="true" {...{[NO_BLOCK_GESTURES_ATTRIBUTE]: 'true'}}
        className="overflow-x-auto overflow-y-hidden" onScroll={syncHeader}>
        <TableContext value={table}>
          <NestedBlockContextProvider overrides={rowsOverrides}>
            <FocusedRowLazyMount block={uiStateBlock} scopeRootId={host.id}/>
            {shown.map(id => <TableRow key={id} id={id} renderScopeId={renderScopeId}/>)}
          </NestedBlockContextProvider>
        </TableContext>
      </div>
      {rowIds && rowIds.length > ROW_CAP && <p className="py-1 text-xs text-muted-foreground">
        Showing the first {ROW_CAP} rows.
      </p>}
      {!repo.isReadOnly && <button type="button" className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => { void controller.appendRow() }}>+ New row</button>}
    </div>
  )
}

const TableRow = ({id, renderScopeId}: {id: string; renderScopeId: string}) => {
  const overrides = useMemo(() => ({[ROW_CONTEXT_KEY]: id}), [id])
  return (
    <NestedBlockContextProvider overrides={overrides}>
      <LazyBlockComponent blockId={id} renderScopeId={renderScopeId}/>
    </NestedBlockContextProvider>
  )
}

const TableHostLayout: BlockLayout = ({block, Header, Shell, Controls, Content, BelowContent, Footer}) => {
  const blockContext = useBlockContext()
  const workspaceId = useHandle(block, {selector: data => data?.workspaceId})
  const parentScope = typeof blockContext.renderScopeId === 'string' ? blockContext.renderScopeId : ''
  const renderScopeId = surfaceRenderScopeId(TABLE_SURFACE, parentScope, block.id)
  return (
    <BlockFrame block={block} Header={Header} Shell={Shell} Controls={Controls} className="tm-table-host">
      <div className="block-body min-w-0 grow">
        <Content/>
        <BelowContent/>
        {workspaceId && <TableGrid key={renderScopeId} host={block} renderScopeId={renderScopeId} workspaceId={workspaceId}/>}
        <Footer/>
      </div>
    </BlockFrame>
  )
}

export { TableCellLayout, TableHostLayout, TableRowLayout }
