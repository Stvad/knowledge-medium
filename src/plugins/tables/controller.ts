/** The grid's cursor and commands. One per mounted table; its identity is
 *  stable for the mount because it rides in the rows' block context, which is
 *  part of every row renderer's slot identity. Focus is always on a row block
 *  (app focus); only the column is held here. */
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { createChild, createSiblingAbove, createSiblingBelow, liveChildAt } from '@/data/mutators'
import type { ChildrenInsertRequest, InsertedBlock } from '@/data/structuralInsert'
import {
  PropertyEditRefusedError, clearPropertyValue, finishPropertyValueEdit, openPropertyValue,
} from '@/data/internals/propertyValueEdits'
import { focusBlock, isCollapsedProp, isEditingBlock, isFocusedBlock, peekFocusedBlockLocation } from '@/data/properties'
import { NO_PROPERTY_DISPLAY_SCOPE, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { OutlineSurface } from '@/data/outlineSurface'
import { lastDrawnStep } from '@/utils/drawnWalk'
import { enterEditModeForBlock } from '@/extensions/blockInteraction'
import { CallbackSet } from '@/utils/callbackSet'
import { showError, showInfo } from '@/utils/toast'
import { ROW_CAP, canAddRow } from './model'
import { forgetCellEdit, openedCellEdit, reportRefusal } from './cellEdits'
import { rowNotes } from './childrenViews'
import { notesInScope, tableNotesScopeId } from './registry'
import { moveVertical } from '@/plugins/spatial-navigation/actions'
import { createQueryRowInTx, rowBackfill } from './query/backfill'
import type { QueryTerm } from './query/parse'

export type GridCommand =
  | 'left' | 'right' | 'up' | 'down' | 'next' | 'previous'
  | 'open' | 'open-start' | 'leave' | 'clear'

/** What the controller needs of a column. */
export interface GridColumn {
  /** The column block. */
  readonly id: string
  /** The property definition, or null for the row's own text. */
  readonly fieldId: string | null
  readonly editable: boolean
  /** A list property: typing over it would replace only its last member. */
  readonly list: boolean
}

/** A cell's inline control (checkbox, date, select): its scalar value's own,
 *  never one in a list member's subtree, which is an outline block's. */
export const CELL_CONTROL_SELECTOR = '[data-table-value] [data-property-value-row] :is(input, button, select, textarea)'

/** How far below a row `rowOf` looks for it. */
const MAX_ROW_DEPTH = 32

/** A row's own cell at `column`, and a cell's own control: never those of a
 *  table drawn inside it (under a list's member). */
const ownCell = (row: HTMLElement, column: number) =>
  [...row.querySelectorAll<HTMLElement>(`[data-table-col="${column}"]`)].find(cell => cell.closest('[data-table-row]') === row)

const ownControl = (cell: HTMLElement) =>
  [...cell.querySelectorAll<HTMLElement>(CELL_CONTROL_SELECTOR)].find(control => control.closest('[data-table-col]') === cell)

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0))

type InsertOrigin = Pick<ChildrenInsertRequest, 'stillCurrent'>

export class GridController {
  private rowIds: readonly string[] = []
  /** Undefined until the row query first answers: nothing is inserted against
   *  a table whose rows (and so its first row and its count) are unknown. */
  private rowCount: number | undefined
  private rowIndex = new Map<string, number>()
  private columns: readonly GridColumn[] = []
  private column = 0
  private readonly columnListeners = new CallbackSet('tables column')
  /** The inline control (checkbox, date, select) that holds DOM focus, if any. */
  private control: HTMLElement | null = null
  private readonly controlListeners = new CallbackSet('tables control')
  /** The row a focus write is still committing to. A key pressed before it
   *  commits moves on from it, not from the row the store still names. */
  private pendingRowId: string | null = null
  private readonly pendingListeners = new CallbackSet('tables pending row')
  private focusWrite: Promise<void> | null = null
  /** An open in flight, and the keys typed while it runs: each would
   *  otherwise open the cell again and replace the first character. */
  private opening: Promise<void> | null = null
  private typedAhead = ''
  /** Bumped by every cursor move, so an open that finishes after the user
   *  moved on does not pull focus back into its cell. */
  private cursorMoves = 0
  private root: HTMLElement | null = null
  /** The query's terms; null when the rows are the host's children. */
  private queryTerms: readonly QueryTerm[] | null = null
  private sorted = false
  parentSurface: OutlineSurface | null = null
  private displayScope: PropertyDisplayScopeLevels = NO_PROPERTY_DISPLAY_SCOPE
  /** Rows made here while a query is set, drawn for as long as the grid is
   *  mounted whether or not they match. */
  private created: readonly string[] = []
  private readonly createdListeners = new CallbackSet('tables created rows')

  constructor(
    readonly host: Block,
    readonly uiStateBlock: Block,
    readonly renderScopeId: string,
    /** Where the host itself is drawn, for leaving the table upwards. */
    private readonly parentRenderScopeId: string,
  ) {}

  /** `rowCount` counts the host's rows past the drawn ones, for the cap. */
  setRows(rowIds: readonly string[], rowCount: number) {
    this.rowIds = rowIds
    this.rowCount = rowCount
    this.rowIndex = new Map(rowIds.map((id, index) => [id, index]))
  }

  /** Refuses, with a notice, a row the table would not draw, and any row
   *  before the rows have loaded. */
  private refuseRowPastCap(): boolean {
    if (this.rowCount === undefined) return true
    if (canAddRow(this.rowCount)) return false
    showInfo(`This table shows at most ${ROW_CAP} rows. Add more in the outline.`)
    return true
  }

  setQuery(terms: readonly QueryTerm[] | null) {
    this.queryTerms = terms
  }

  get hasQuery(): boolean {
    return this.queryTerms !== null
  }

  /** Whether the rows are drawn in a sort's order rather than the host's. */
  setSorted(sorted: boolean) {
    this.sorted = sorted
  }

  /** Whether a row may be made here; refuses, with a notice, as the grid's own inserts do. */
  allowsNewRow(): boolean {
    return !this.refuseRowPastCap()
  }

  get rowOrder() {
    if (this.hasQuery) return 'query' as const
    return this.sorted ? 'derived' as const : 'outline' as const
  }

  setSurfaces(rows: PropertyDisplayScopeLevels, owner: OutlineSurface | null) {
    this.displayScope = rows
    this.parentSurface = owner
  }

  get rowsDisplayScope(): PropertyDisplayScopeLevels {
    return this.displayScope
  }

  /** During render use the incoming query state until setQuery publishes it at layout commit. */
  notesScopeId(rowId: string, hasQuery = this.hasQuery): string {
    return hasQuery ? tableNotesScopeId(this.renderScopeId, rowId) : this.renderScopeId
  }

  /** The row is the structural root of its notes. */
  rowSurface(rowId: string): OutlineSurface {
    return {scopeRootId: rowId, scopeRootForcesOpen: false, propertyDisplay: this.displayScope, renderScopeId: this.renderScopeId}
  }

  /** A row's notes as the grid draws them: none while it is collapsed. */
  async drawnChildIds(rowId: string): Promise<string[]> {
    const row = this.host.repo.block(rowId)
    await row.load()
    return row.peekProperty(isCollapsedProp) ?? false ? [] : this.childIdsOf(rowId)
  }

  /** A row's notes, shown or collapsed: the list `RowNotes` draws. */
  childIdsOf(rowId: string): Promise<string[]> {
    return rowNotes(this.host.repo.block(rowId), this.rowIds).load()
  }

  /** The last block a row draws: its last note followed down as the outline
   *  draws it, or the row itself. `crossed` when a table there ends what the
   *  row draws: the block named is above that table's grid, not beside the next row. */
  async lastDrawnIn(rowId: string): Promise<{block: Block; crossed: boolean}> {
    const lastNote = (await this.drawnChildIds(rowId)).at(-1)
    if (lastNote === undefined) return {block: this.host.repo.block(rowId), crossed: false}
    const surface = {...this.rowSurface(rowId), renderScopeId: this.notesScopeId(rowId)}
    return lastDrawnStep(this.host.repo.block(lastNote), surface, {withinScope: true})
  }

  /** ArrowDown from a row's text: its first drawn child, edited from its
   *  start, or the next row in row mode when it draws none. */
  private async editFirstDrawnIn(row: number) {
    const moves = this.cursorMoves
    const rowId = this.rowIds[row]!
    const first = (await this.drawnChildIds(rowId))[0]
    if (this.cursorMoves !== moves) return
    if (!first) {
      this.focusRow(clamp(row + 1, this.rowIds.length - 1))
      return
    }
    await focusBlock(this.uiStateBlock, first, {
      edit: true,
      renderScopeId: this.notesScopeId(rowId),
      selection: {start: 0},
    })
  }

  /** ArrowUp from a row's text: the last block the row above draws, edited
   *  at its last line, or the row above in row mode when it draws nothing more. */
  private async editLastDrawnAbove(row: number) {
    const aboveId = this.rowIds[row - 1]!
    const moves = this.cursorMoves
    const {block: target} = await this.lastDrawnIn(aboveId)
    if (this.cursorMoves !== moves) return
    if (target.id === aboveId) {
      this.focusRow(row - 1)
      return
    }
    await focusBlock(this.uiStateBlock, target.id, {
      edit: true,
      renderScopeId: this.notesScopeId(aboveId),
      selection: {line: 'last'},
    })
  }

  readonly subscribeCreated = (listener: () => void) => this.createdListeners.add(listener)
  readonly getCreated = () => this.created

  /** The cursor stays on its column, not its position, when columns are
   *  reordered, hidden or deleted. */
  setColumns(columns: readonly GridColumn[]) {
    const cursorId = this.columns[this.column]?.id
    this.columns = columns
    const kept = cursorId === undefined ? -1 : columns.findIndex(column => column.id === cursorId)
    if (kept >= 0 && kept !== this.column) {
      this.column = kept
      this.columnListeners.notify()
    } else if (this.column >= columns.length) {
      this.setColumn(columns.length - 1)
    }
  }

  /** The row index of a row block, or of the row whose cell draws this block:
   *  its nearest ancestor that is a row. Read from the cache, which holds
   *  every block a mounted row draws. */
  rowOf(blockId: string): number | undefined {
    const repo = this.host.repo
    for (let id: string | null | undefined = blockId, depth = 0; id && depth < MAX_ROW_DEPTH; depth++) {
      const row = this.rowIndex.get(id)
      if (row !== undefined) return row
      id = repo.block(id).peek()?.parentId
    }
    return undefined
  }

  isRow(blockId: string): boolean {
    return this.rowIndex.has(blockId)
  }

  /** The rows, in the order drawn. */
  get rows(): readonly string[] {
    return this.rowIds
  }

  /** Focus on a cell's field row, which the grid does not draw (an outline
   *  verb lands there from a list's first member: up, delete, jump), moves
   *  to its row at its column. */
  leaveFieldRow(blockId: string) {
    // Raw: finishing a draft may already have deleted the field row focus landed on.
    const field = this.host.repo.block(blockId).peekRaw()
    const row = field?.isFieldForm && field.parentId ? this.rowIndex.get(field.parentId) : undefined
    if (row === undefined) return
    const column = this.columns.findIndex(column => column.fieldId === field!.referenceTargetId)
    this.focusRow(row, column >= 0 ? column : this.column)
  }

  get currentColumn() {
    return this.column
  }

  readonly subscribeColumn = (listener: () => void) => this.columnListeners.add(listener)
  readonly subscribeControl = (listener: () => void) => this.controlListeners.add(listener)
  readonly subscribePending = (listener: () => void) => this.pendingListeners.add(listener)
  readonly getPendingRow = () => this.pendingRowId
  /** A control removed without a blur no longer holds focus. */
  readonly isInControl = () => this.control?.isConnected === true

  setRoot(root: HTMLElement | null) {
    this.root = root
  }

  private setControl(control: HTMLElement | null) {
    if (control === this.control) return
    this.control = control
    this.controlListeners.notify()
  }

  private setPendingRow(rowId: string | null) {
    if (rowId === this.pendingRowId) return
    this.pendingRowId = rowId
    this.pendingListeners.notify()
  }

  /** An inline control in a cell took DOM focus: the row takes app focus
   *  without taking DOM focus back from the control. */
  controlFocused(rowId: string, column: number, control: HTMLElement) {
    this.setColumn(column)
    this.setControl(control)
    if (!isFocusedBlock(this.uiStateBlock, rowId, this.renderScopeId)) {
      void focusBlock(this.uiStateBlock, rowId, {renderScopeId: this.renderScopeId})
    }
  }

  controlBlurred(control: HTMLElement) {
    if (this.control === control) this.setControl(null)
  }

  /** A click on a cell: focus its row at that column, or open it. */
  focusCell(rowId: string, column: number, open: boolean) {
    const row = this.rowIndex.get(rowId)
    if (row === undefined) return
    this.focusRow(row, column)
    if (open) this.command('open')
  }

  /** Synchronous: a deferred column change races the focus an inline control
   *  takes. Returns whether the column moved. */
  setColumn(column: number): boolean {
    const next = clamp(column, this.columns.length - 1)
    if (next === this.column) return false
    this.column = next
    this.cursorMoves++
    this.columnListeners.notify()
    const focused = this.focusedRow()
    if (focused) this.revealColumn(focused.row)
    return true
  }

  /** Scroll the cursor's cell clear of the frozen first column and the right edge. */
  private revealColumn(row: number) {
    const element = this.rowElement(row)
    const cell = element && ownCell(element, this.column)
    const scroller = cell?.closest<HTMLElement>('[data-table-scroller]')
    if (!cell || !scroller) return
    const view = scroller.getBoundingClientRect()
    // The frozen first column's right edge: it sticks beside the row's frozen controls.
    const frozenRight = this.column > 0 ? ownCell(element!, 0)?.getBoundingClientRect().right ?? view.left : view.left
    const box = cell.getBoundingClientRect()
    if (box.left < frozenRight) scroller.scrollLeft -= frozenRight - box.left
    else if (box.right > view.right) scroller.scrollLeft += box.right - view.right
  }

  /** The row the panel's focus is on, when it is in this table: the row
   *  block itself, or a value row of one of its cells. */
  private focusedRow(): {row: number; onRow: boolean} | undefined {
    const pending = this.pendingRowId === null ? undefined : this.rowIndex.get(this.pendingRowId)
    if (pending !== undefined) return {row: pending, onRow: true}
    const location = peekFocusedBlockLocation(this.uiStateBlock)
    if (!location?.renderScopeId) return undefined
    const notes = notesInScope(location.renderScopeId)
    if (notes?.grid === this) {
      const row = this.rowIndex.get(notes.rowId)
      return row === undefined ? undefined : {row, onRow: false}
    }
    if (location.renderScopeId !== this.renderScopeId) return undefined
    const row = this.rowOf(location.blockId)
    return row === undefined ? undefined : {row, onRow: this.rowIndex.has(location.blockId)}
  }

  private rowElement(row: number) {
    const id = this.rowIds[row]
    return id ? this.root?.querySelector<HTMLElement>(`[data-table-row="${CSS.escape(id)}"]`) ?? null : null
  }

  /** Put app focus on a row (not editing), and DOM focus on its shell when it is mounted. */
  focusRow(row: number, column = this.column) {
    const rowId = this.rowIds[row]
    if (!rowId) return
    this.setControl(null)
    this.setColumn(column)
    this.revealColumn(row)
    const element = this.rowElement(row)
    if (element) element.focus({preventScroll: true})
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    this.cursorMoves++
    this.setPendingRow(rowId)
    this.focusWrite ??= this.writePendingFocus()
  }

  /** One focus write at a time, always to the latest row: held arrow keys
   *  outrun the writes, and a queue of them would keep moving focus after
   *  the keys stop. A failed write drops the pending row, so it cannot keep
   *  answering for a focus that never landed. */
  private async writePendingFocus(): Promise<void> {
    // Settle the caller's assignment before `finally` can clear it.
    await Promise.resolve()
    try {
      while (this.pendingRowId !== null) {
        const rowId = this.pendingRowId
        await focusBlock(this.uiStateBlock, rowId, {renderScopeId: this.renderScopeId})
        if (this.pendingRowId === rowId) this.setPendingRow(null)
      }
    } catch (error) {
      this.setPendingRow(null)
      console.error('[tables] focus write failed', error)
    } finally {
      this.focusWrite = null
    }
  }

  /** Up from the first row or Down from the last, with the row focused: the
   *  step out of the grid. While a move to this row is still committing,
   *  absorb the key so that write cannot overwrite the exit. */
  private leaveRows(row: number, direction: 'up' | 'down'): true {
    if (this.pendingRowId !== null) return true
    const rowId = this.rowIds[row]!
    const from = {...this.rowSurface(rowId), block: this.host.repo.block(rowId), uiStateBlock: this.uiStateBlock}
    void moveVertical(from, direction, {descend: false, modelFallback: true}).then(handled => {
      if (!handled && direction === 'up') this.focusHost()
    })
    return true
  }

  private focusHost() {
    void focusBlock(this.uiStateBlock, this.host.id, {renderScopeId: this.parentRenderScopeId})
  }

  /** Run a grid command. Returns false when it does not apply, so the key
   *  falls through to whatever else binds it. */
  readonly command = (command: GridCommand, key?: string): boolean => {
    const focused = this.focusedRow()
    if (!focused) return false
    const {row, onRow} = focused
    const inRowMode = onRow && !this.isInControl() &&
      !isEditingBlock(this.uiStateBlock, this.rowIds[row]!, this.renderScopeId)
    switch (command) {
      case 'left': case 'previous': case 'right': case 'next': {
        const step = command === 'left' || command === 'previous' ? -1 : 1
        if (!inRowMode) {
          this.focusRow(row, this.column + step)
          return true
        }
        return this.setColumn(this.column + step)
      }
      case 'up':
        if (row === 0) {
          if (inRowMode) return this.leaveRows(row, 'up')
          this.focusHost()
          return true
        }
        // From a row's text being edited, into what the row above draws last.
        if (onRow && !inRowMode) void this.editLastDrawnAbove(row)
        else this.focusRow(row - 1)
        return true
      case 'down':
        // From a row's text being edited, into its first drawn child.
        if (onRow && !inRowMode) void this.editFirstDrawnIn(row)
        else if (row === this.rowIds.length - 1 && inRowMode) return this.leaveRows(row, 'down')
        else this.focusRow(clamp(row + 1, this.rowIds.length - 1))
        return true
      case 'leave':
        this.focusRow(row)
        return true
      case 'open': case 'open-start':
        if (this.opening) {
          if (key !== undefined) this.typedAhead += key
          return true
        }
        this.opening = this.open(row, key, command === 'open-start').catch(reportRefusal).finally(() => {
          this.opening = null
          this.typedAhead = ''
        })
        return true
      case 'clear':
        void this.clear(row).catch(reportRefusal)
        return true
    }
  }

  private assertEditable(column: GridColumn) {
    if (!column.editable || this.host.repo.isReadOnly) {
      throw new PropertyEditRefusedError('read-only', 'This column is read-only here.')
    }
  }

  /** Append what was typed while opening to the block the editor will show. */
  private async flushTypedAhead(block: Block) {
    const ahead = this.typedAhead
    this.typedAhead = ''
    if (ahead) await block.setContent(`${block.peek()?.content ?? ''}${ahead}`)
  }

  /** Open the cursor's cell. `text` is a typed first character: it replaces
   *  a scalar value, as typing over a spreadsheet cell does. */
  private async open(row: number, text?: string, atStart = false): Promise<void> {
    const rowId = this.rowIds[row]
    const column = this.columns[this.column]
    if (!rowId || !column) return
    const moves = this.cursorMoves
    const repo = this.host.repo
    const rowBlock = repo.block(rowId)
    if (column.fieldId === null) {
      if (text !== undefined && !repo.isReadOnly) {
        await rowBlock.load()
        this.typedAhead = text + this.typedAhead
        await this.flushTypedAhead(rowBlock)
      }
      if (this.cursorMoves !== moves) return
      const length = rowBlock.peek()?.content.length ?? 0
      return enterEditModeForBlock(rowBlock, this.uiStateBlock, this.renderScopeId, {start: atStart ? 0 : length})
    }
    // The cell's control and kind are known only once its row is drawn.
    const element = this.rowElement(row)
    if (!element) return
    const cell = ownCell(element, this.column)
    const control = cell && ownControl(cell)
    if (control) {
      control.focus()
      return
    }
    this.assertEditable(column)
    const fieldId = column.fieldId
    // Typing over a list would replace its last member: a list opens as Enter does.
    const initialText = column.list ? undefined : text
    if (column.list) this.typedAhead = ''
    const opened = await repo.tx(
      tx => openPropertyValue(tx, rowId, fieldId, initialText === undefined ? {} : {initialText}),
      {scope: ChangeScope.BlockDefault, description: 'edit table cell'},
    )
    openedCellEdit(opened, rowId, fieldId, this.renderScopeId)
    try {
      const value = repo.block(opened.valueId)
      await value.load()
      if (!column.list) await this.flushTypedAhead(value)
      if (this.cursorMoves !== moves) {
        // No editor will mount to finish this edit: finish it here, so a draft
        // it created is not left set.
        forgetCellEdit(opened.valueId, this.renderScopeId)
        await repo.tx(tx => finishPropertyValueEdit(tx, rowId, fieldId, opened, value.peek()?.content ?? ''),
          {scope: ChangeScope.BlockDefault, description: 'finish table cell edit'})
        return
      }
      const length = value.peek()?.content.length ?? 0
      await enterEditModeForBlock(value, this.uiStateBlock, this.renderScopeId, {start: atStart ? 0 : length})
    } catch (error) {
      forgetCellEdit(opened.valueId, this.renderScopeId)
      throw error
    }
  }

  private async clear(row: number): Promise<void> {
    const rowId = this.rowIds[row]
    const column = this.columns[this.column]
    if (!rowId || column?.fieldId == null) return
    this.assertEditable(column)
    const fieldId = column.fieldId
    await this.host.repo.tx(tx => clearPropertyValue(tx, rowId, fieldId),
      {scope: ChangeScope.BlockDefault, description: 'clear table cell'})
  }

  /** Place the first row above existing rows, after the view machinery. */
  insertFirstRow(origin?: InsertOrigin): Promise<InsertedBlock | null> {
    return this.insertNewRow(this.rowIds[0], 'before', origin)
  }

  async appendRow(): Promise<void> {
    const target = await this.insertNewRow(undefined, 'after')
    if (target) await focusBlock(this.uiStateBlock, target.id, {edit: target.edit, renderScopeId: target.renderScopeId})
  }

  /** A query places a sibling request as a new query row. The origin and
   *  placement anchor are checked again in the writing transaction. */
  async insertNewRow(rowId: string | undefined, side: 'before' | 'after', origin?: InsertOrigin): Promise<InsertedBlock | null> {
    const repo = this.host.repo
    if (repo.isReadOnly || !this.allowsNewRow()) return null
    const terms = this.queryTerms
    const hostId = this.host.id
    const id = await repo.tx(async tx => {
      if (origin && !await origin.stillCurrent(tx)) return null
      if (!terms && rowId !== undefined && !await liveChildAt(tx, rowId, hostId)) return null
      if (terms) return createQueryRowInTx(repo, tx, hostId, rowBackfill(terms))
      if (rowId === undefined) return tx.run(createChild, {parentId: hostId, position: {kind: 'last'}})
      return tx.run(side === 'before' ? createSiblingAbove : createSiblingBelow, {siblingId: rowId})
    }, {scope: ChangeScope.BlockDefault, description: 'new table row'}).catch(error => {
      if (!terms) throw error
      showError(`Could not add a row: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (id === null) return null
    if (terms) {
      this.created = [...this.created, id]
      this.createdListeners.notify()
    }
    const content = this.columns.findIndex(column => column.fieldId === null)
    if (content >= 0) this.setColumn(content)
    return {id, edit: content >= 0, renderScopeId: this.renderScopeId}
  }
}
