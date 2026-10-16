import { charBoundary, cutMarker } from './text.ts'

/** Past this a string cell is cut (and marked) in the RESULT: one
 *  extension-source or long-note cell would otherwise dominate it. The cut
 *  happens after SQLite hands the row over, so a query naming a huge cell
 *  still reads it once; bounding that is the query's job (`substr()`,
 *  `length()`), since an arbitrary statement's columns cannot be rewritten. */
export const SQL_CELL_CHARS = 2000
/** The ceiling on `maxRows`, whatever the caller asks: like every other
 *  bounded view, the caller picks a size inside a bound, not the bound. */
export const MAX_SQL_ROWS = 1000

export interface BoundedSqlRows {
  rows: unknown[]
  /** More rows matched than `rows` holds. */
  truncated: boolean
  truncatedCells: number
}

/** A single SELECT/WITH statement wrapped so SQLite stops after
 *  `maxRows + 1` rows — the extra row is how `truncated` is known — or null
 *  for any other statement, which is then bounded only after it runs. The
 *  newlines keep a trailing `--` comment from swallowing the closing paren. */
export const limitedSelectSql = (sql: string, maxRows: number): string | null => {
  const body = sql.trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(body) || body.includes(';')) return null
  return `SELECT * FROM (\n${body}\n) LIMIT ${maxRows + 1}`
}

/** The agent-bounded form of an `all` result: at most `maxRows` rows, long
 *  string cells cut with their char count, binary cells summarized by size. */
export const boundSqlRows = (rows: readonly unknown[], maxRows: number): BoundedSqlRows => {
  let truncatedCells = 0
  const cutCell = (value: unknown): unknown => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      truncatedCells += 1
      return `[blob ${value.byteLength} bytes]`
    }
    if (typeof value !== 'string' || value.length <= SQL_CELL_CHARS) return value
    truncatedCells += 1
    const end = charBoundary(value, SQL_CELL_CHARS)
    return `${value.slice(0, end)}${cutMarker(value.length - end)}`
  }
  const shown = rows.slice(0, maxRows).map(row =>
    row !== null && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cutCell(value)]))
      : cutCell(row))
  return {rows: shown, truncated: rows.length > maxRows, truncatedCells}
}
