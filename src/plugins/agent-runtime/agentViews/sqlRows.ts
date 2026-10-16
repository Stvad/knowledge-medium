import { cutMarker } from './text.ts'

/** Past this a string cell is cut (and marked): one extension-source or
 *  long-note cell would otherwise dominate a result. `substr()` in the
 *  query reads a cell piecewise. */
export const SQL_CELL_CHARS = 2000

export interface BoundedSqlRows {
  rows: unknown[]
  totalRows: number
  truncated: boolean
  truncatedCells: number
}

/** The agent-bounded form of an `all` result: at most `maxRows` rows, long
 *  string cells cut with their char count. */
export const boundSqlRows = (rows: readonly unknown[], maxRows: number): BoundedSqlRows => {
  let truncatedCells = 0
  const cutCell = (value: unknown): unknown => {
    if (typeof value !== 'string' || value.length <= SQL_CELL_CHARS) return value
    truncatedCells += 1
    return `${value.slice(0, SQL_CELL_CHARS)}${cutMarker(value.length - SQL_CELL_CHARS)}`
  }
  const shown = rows.slice(0, maxRows).map(row =>
    row !== null && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cutCell(value)]))
      : cutCell(row))
  return {rows: shown, totalRows: rows.length, truncated: rows.length > maxRows, truncatedCells}
}
