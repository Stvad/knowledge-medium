/** The grid's cursor and commands. One per mounted table; its identity is
 *  stable for the mount because it rides in the rows' block context, which is
 *  part of every row renderer's slot identity. Focus is always on a row block
 *  (app focus); only the column is held here. */
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import {
  PropertyEditRefusedError, clearPropertyValue, openPropertyValue,
} from '@/data/internals/propertyValueEdits'
import { focusBlock, isEditingBlock, peekFocusedBlockLocation } from '@/data/properties'
import { enterEditModeForBlock } from '@/extensions/blockInteraction'
import { CallbackSet } from '@/utils/callbackSet'
import { showError } from '@/utils/toast'
import { openedCellEdit } from './cellEdits'
import type { TableColumn } from './model'

export type GridCommand =
  | 'left' | 'right' | 'up' | 'down' | 'next' | 'previous'
  | 'open' | 'open-start' | 'leave' | 'clear' | 'insert-below' | 'insert-above'

export const CELL_CONTROL_SELECTOR = '[data-property-value-row] :is(input, button, select, textarea)'

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0))

const reportRefusal = (error: unknown) => {
  if (!(error instanceof PropertyEditRefusedError)) throw error
  showError(error.message)
}

export class GridController {
  private rowIds: readonly string[] = []
  private rowIndex = new Map<string, number>()
  private columns: readonly TableColumn[] = []
  private editable: readonly boolean[] = []
  private column = 0
  private readonly columnListeners = new CallbackSet('tables column')
  private readonly controlListeners = new CallbackSet('tables control')
  /** The row a focus write is still committing to. A key pressed before it
   *  commits moves on from it, not from the row the store still names. */
  private pendingRowId: string | null = null
  private readonly pendingListeners = new CallbackSet('tables pending row')
  private root: HTMLElement | null = null
  /** The inline control (checkbox, date, select) that holds DOM focus, if any. */
  private control: HTMLElement | null = null
  /** Whether vim's normal mode is active; it owns printable keys then. */
  private normalMode = false
  readonly run = (command: GridCommand, key?: string) => this.command(command, key)
  readonly isNormalModeActive = () => this.normalMode

  constructor(
    readonly host: Block,
    readonly uiStateBlock: Block,
    readonly renderScopeId: string,
  ) {}

  setRows(rowIds: readonly string[]) {
    this.rowIds = rowIds
    this.rowIndex = new Map(rowIds.map((id, index) => [id, index]))
  }

  setColumns(columns: readonly TableColumn[], editable: readonly boolean[]) {
    this.columns = columns
    this.editable = editable
    if (this.column >= columns.length) this.setColumn(columns.length - 1)
  }

  hasRow(id: string) {
    return this.rowIndex.has(id)
  }

  get currentColumn() {
    return this.column
  }

  readonly subscribeColumn = (listener: () => void) => this.columnListeners.add(listener)

  readonly subscribeControl = (listener: () => void) => this.controlListeners.add(listener)
  readonly isInControl = () => this.control !== null
  readonly subscribePending = (listener: () => void) => this.pendingListeners.add(listener)
  readonly getPendingRow = () => this.pendingRowId

  private setPendingRow(rowId: string | null) {
    if (rowId === this.pendingRowId) return
    this.pendingRowId = rowId
    this.pendingListeners.notify()
  }

  setRoot(root: HTMLElement | null) {
    this.root = root
  }

  setNormalMode(active: boolean) {
    this.normalMode = active
  }

  private setControl(control: HTMLElement | null) {
    if (control === this.control) return
    this.control = control
    this.controlListeners.notify()
  }

  /** An inline control in a cell took DOM focus: the row takes app focus
   *  without taking DOM focus back from the control. */
  controlFocused(rowId: string, column: number, control: HTMLElement) {
    this.setColumn(column)
    this.setControl(control)
    const location = peekFocusedBlockLocation(this.uiStateBlock)
    if (location?.blockId !== rowId || location.renderScopeId !== this.renderScopeId) {
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
    if (open) void this.open(row).catch(reportRefusal)
  }

  /** Synchronous: a deferred column change races the focus an inline control takes. */
  setColumn(column: number) {
    const next = clamp(column, this.columns.length - 1)
    if (next === this.column) return
    this.column = next
    this.columnListeners.notify()
    const focused = this.focusedRow()
    if (focused) this.revealColumn(focused.row)
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
    const direct = this.rowIndex.get(location.blockId)
    if (direct !== undefined) return {row: direct, onRow: true}
    const repo = this.host.repo
    const fieldId = repo.block(location.blockId).peek()?.parentId
    const ownerId = fieldId ? repo.block(fieldId).peek()?.parentId : undefined
    const row = ownerId ? this.rowIndex.get(ownerId) : undefined
    return row === undefined ? undefined : {row, onRow: false}
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
    this.setPendingRow(rowId)
    this.focusWrite ??= this.writePendingFocus()
  }

  private focusWrite: Promise<void> | null = null

  /** One focus write at a time, always to the latest row: held arrow keys
   *  outrun the writes, and a queue of them would keep moving focus after
   *  the keys stop. */
  private async writePendingFocus(): Promise<void> {
    try {
      while (this.pendingRowId !== null) {
        const rowId = this.pendingRowId
        await focusBlock(this.uiStateBlock, rowId, {renderScopeId: this.renderScopeId})
        if (this.pendingRowId === rowId) this.setPendingRow(null)
      }
    } finally {
      this.focusWrite = null
    }
  }

  command(command: GridCommand, key?: string): void {
    const focused = this.focusedRow()
    if (!focused) return
    const {row, onRow} = focused
    const inControl = this.control !== null
    const inRowMode = onRow && !inControl &&
      !isEditingBlock(this.uiStateBlock, this.rowIds[row]!, this.renderScopeId)
    switch (command) {
      case 'left': case 'previous':
        if (inRowMode) return this.setColumn(this.column - 1)
        return this.focusRow(row, this.column - 1)
      case 'right': case 'next':
        if (inRowMode) return this.setColumn(this.column + 1)
        return this.focusRow(row, this.column + 1)
      case 'up':
        return this.focusRow(clamp(row - 1, this.rowIds.length - 1))
      case 'down':
        return this.focusRow(clamp(row + 1, this.rowIds.length - 1))
      case 'leave':
        return this.focusRow(row)
      case 'open': case 'open-start':
        void this.open(row, key, command === 'open-start').catch(reportRefusal)
        return
      case 'clear':
        void this.clear(row).catch(reportRefusal)
        return
      case 'insert-below': case 'insert-above':
        void this.insertRow(row, command === 'insert-below' ? 'below' : 'above')
        return
    }
  }

  /** Open the cursor's cell. `text` is a typed first character: it replaces
   *  an existing value, as typing over a spreadsheet cell does. */
  async open(row: number, text?: string, atStart = false): Promise<void> {
    const rowId = this.rowIds[row]
    const column = this.columns[this.column]
    if (!rowId || !column) return
    const repo = this.host.repo
    const rowBlock = repo.block(rowId)
    if (column.fieldId === null) {
      if (text !== undefined && !repo.isReadOnly) {
        await rowBlock.load()
        await rowBlock.setContent(`${rowBlock.peek()?.content ?? ''}${text}`)
      }
      const length = rowBlock.peek()?.content.length ?? 0
      return enterEditModeForBlock(rowBlock, this.uiStateBlock, this.renderScopeId, {start: atStart ? 0 : length})
    }
    const control = this.rowElement(row)
      ?.querySelector<HTMLElement>(`[data-table-col="${this.column}"] ${CELL_CONTROL_SELECTOR}`)
    if (control) {
      control.focus()
      return
    }
    if (!this.editable[this.column] || repo.isReadOnly) {
      throw new PropertyEditRefusedError('read-only', 'This column is read-only here.')
    }
    const fieldId = column.fieldId
    const opened = await repo.tx(
      tx => openPropertyValue(tx, rowId, fieldId, text === undefined ? {} : {initialText: text}),
      {scope: ChangeScope.BlockDefault, description: 'edit table cell'},
    )
    openedCellEdit(opened, this.renderScopeId)
    const value = repo.block(opened.valueId)
    await value.load()
    const length = value.peek()?.content.length ?? 0
    await enterEditModeForBlock(value, this.uiStateBlock, this.renderScopeId, {start: atStart ? 0 : length})
  }

  async clear(row: number): Promise<void> {
    const rowId = this.rowIds[row]
    const column = this.columns[this.column]
    if (!rowId || column?.fieldId == null) return
    if (!this.editable[this.column] || this.host.repo.isReadOnly) {
      throw new PropertyEditRefusedError('read-only', 'This column is read-only here.')
    }
    const fieldId = column.fieldId
    await this.host.repo.tx(tx => clearPropertyValue(tx, rowId, fieldId),
      {scope: ChangeScope.BlockDefault, description: 'clear table cell'})
  }

  /** A new row beside the focused one, under the host, editing its text. */
  async insertRow(row: number, side: 'below' | 'above'): Promise<void> {
    const rowId = this.rowIds[row]
    const repo = this.host.repo
    if (!rowId || repo.isReadOnly) return
    const id = side === 'below'
      ? await repo.mutate.createSiblingBelow({siblingId: rowId})
      : await repo.mutate.createSiblingAbove({siblingId: rowId})
    if (!id) return
    await this.editNewRow(id)
  }

  /** A new last row, editing its text. */
  async appendRow(): Promise<void> {
    const repo = this.host.repo
    if (repo.isReadOnly) return
    const id = await repo.mutate.createChild({parentId: this.host.id, position: {kind: 'last'}})
    if (id) await this.editNewRow(id)
  }

  /** A new row has only its text to fill in, in the column that shows it. */
  private async editNewRow(id: string) {
    this.setColumn(Math.max(this.columns.findIndex(column => column.fieldId === null), 0))
    await focusBlock(this.uiStateBlock, id, {edit: true, renderScopeId: this.renderScopeId})
  }
}
