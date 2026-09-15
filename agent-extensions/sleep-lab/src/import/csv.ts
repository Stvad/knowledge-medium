/** A small RFC-4180-ish CSV parser — quotes, escaped `""`, commas inside
 *  quotes, CRLF/LF line endings. No dependency: the exports this package can
 *  install into have to work with none. */

/** Parse CSV text into rows of raw string cells. A trailing newline produces
 *  no phantom empty row; an interior blank line becomes a one-cell `['']`
 *  row (callers that treat blank lines as noise filter those themselves —
 *  see {@link rowsWithHeader}). */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length

  while (i < len) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += char
    i += 1
  }
  // A file with no trailing newline still has a final row to flush; a file
  // that ends cleanly on a newline must not get a phantom empty one.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** `parseCsv` plus header mapping: row *N* → `{header[i]: cell}`. A row with
 *  more cells than the header (a trailing-comma artifact some exporters
 *  leave behind) keeps only the header's columns; a row with fewer treats
 *  the missing cells as `''`. Blank lines (a single empty cell) are dropped
 *  rather than surfacing as an all-empty row. */
export const rowsWithHeader = (
  text: string,
  options: {skipFirstLine?: boolean} = {},
): {header: string[]; rows: Record<string, string>[]} => {
  const allRows = parseCsv(text)
  const startIndex = options.skipFirstLine ? 1 : 0
  const header = allRows[startIndex] ?? []
  const rows = allRows
    .slice(startIndex + 1)
    .filter(cells => !(cells.length === 1 && cells[0] === ''))
    .map(cells => {
      const record: Record<string, string> = {}
      header.forEach((name, i) => {
        record[name] = cells[i] ?? ''
      })
      return record
    })
  return {header, rows}
}
