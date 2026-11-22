/** The grid's cursor and commands. One per mounted table; its identity is
 *  stable for the mount because it rides in the rows' block context, which is
 *  part of every row renderer's slot identity. Focus is always on a row block
 *  (app focus); only the column is held here. */
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import {
  PropertyEditRefusedError, clearPropertyValue, finishPropertyValueEdit, openPropertyValue,
} from '@/data/internals/propertyValueEdits'
import { focusBlock, isEditingBlock, isFocusedBlock, peekFocusedBlockLocation } from '@/data/properties'
import { enterEditModeForBlock } from '@/extensions/blockInteraction'
import { CallbackSet } from '@/utils/callbackSet'
import { showError, showInfo } from '@/utils/toast'
import { ROW_CAP, canAddRow } from './model'
import { forgetCellEdit, openedCellEdit, reportRefusal } from './cellEdits'
import { createQueryRow, rowBackfill } from './query/backfill'
import type { QueryTerm } from './query/parse'

export type GridCommand =
  | 'left' | 'right' | 'up' | 'down' | 'next' | 'previous'
  | 'open' | 'open-start' | 'leave' | 'clear' | 'insert-below' | 'insert-above'

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

export const CELL_CONTROL_SELECTOR = '[data-property-value-row] :is(input, button, select, textarea)'

/** How far below a row `rowOf` looks for it. */
const MAX_ROW_DEPTH = 32

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0))

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
    const cell = element?.querySelector<HTMLElement>(`[data-table-col="${this.column}"]`)
    const scroller = cell?.closest<HTMLElement>('[data-table-scroller]')
    if (!cell || !scroller) return
    const frozen = this.column > 0 ? element!.querySelector('[data-table-col="0"]')?.getBoundingClientRect().width ?? 0 : 0
    const view = scroller.getBoundingClientRect()
    const box = cell.getBoundingClientRect()
    if (box.left < view.left + frozen) scroller.scrollLeft -= view.left + frozen - box.left
    else if (box.right > view.right) scroller.scrollLeft += box.right - view.right
  }

  /** The row the panel's focus is on, when it is in this table: the row
   *  block itself, or a value row of one of its cells. */
  private focusedRow(): {row: number; onRow: boolean} | undefined {
    const pending = this.pendingRowId === null ? undefined : this.rowIndex.get(this.pendingRowId)
    if (pending !== undefined) return {row: pending, onRow: true}
    const location = peekFocusedBlockLocation(this.uiStateBlock)
    if (location?.renderScopeId !== this.renderScopeId) return undefined
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
          void focusBlock(this.uiStateBlock, this.host.id, {renderScopeId: this.parentRenderScopeId})
          return true
        }
        this.focusRow(row - 1)
        return true
      case 'down':
        this.focusRow(clamp(row + 1, this.rowIds.length - 1))
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
      case 'insert-below': case 'insert-above':
        void this.insertRow(row, command === 'insert-below' ? 'below' : 'above')
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
    const control = element.querySelector<HTMLElement>(`[data-table-col="${this.column}"] ${CELL_CONTROL_SELECTOR}`)
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

  /** A new row beside the focused one, under the host, editing its text. A
   *  query's rows live anywhere, so there it is a new row like "+ New row". */
  private async insertRow(row: number, side: 'below' | 'above'): Promise<void> {
    if (this.queryTerms) return this.appendRow()
    const rowId = this.rowIds[row]
    const repo = this.host.repo
    if (!rowId || repo.isReadOnly || this.refuseRowPastCap()) return
    const id = side === 'below'
      ? await repo.mutate.createSiblingBelow({siblingId: rowId})
      : await repo.mutate.createSiblingAbove({siblingId: rowId})
    if (id) await this.editNewRow(id)
  }

  /** A new first row, editing its text: what the outline's "create below" makes
   *  on a block that shows its children. Placed above the first row rather than
   *  as the host's first child, so the view block stays first. */
  insertFirstRow(): Promise<void> {
    return this.rowIds.length > 0 ? this.insertRow(0, 'above') : this.appendRow()
  }

  /** A new last row, editing its text. Under a query it carries what the
   *  query implies, so it matches when it can (`./query/backfill`). */
  async appendRow(): Promise<void> {
    const repo = this.host.repo
    if (repo.isReadOnly || this.refuseRowPastCap()) return
    const id = this.queryTerms
      ? await this.createQueryRow(this.queryTerms)
      : await repo.mutate.createChild({parentId: this.host.id, position: {kind: 'last'}})
    if (!id) return
    if (this.queryTerms) {
      this.created = [...this.created, id]
      this.createdListeners.notify()
    }
    await this.editNewRow(id)
  }

  /** The query's parent can be gone or read-only by now; the transaction then
   *  writes nothing, and the user is told. */
  private async createQueryRow(terms: readonly QueryTerm[]): Promise<string | undefined> {
    try {
      return await createQueryRow(this.host.repo, this.host.id, rowBackfill(terms))
    } catch (error) {
      showError(`Could not add a row: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** A new row has only its text to fill in, in the column that shows it. A
   *  view with no such column focuses the row instead: its text has nowhere
   *  to be edited. */
  private async editNewRow(id: string) {
    const content = this.columns.findIndex(column => column.fieldId === null)
    if (content >= 0) this.setColumn(content)
    await focusBlock(this.uiStateBlock, id, {edit: content >= 0, renderScopeId: this.renderScopeId})
  }
}
