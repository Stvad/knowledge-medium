/**
 * Renders the flat `get-subtree` result as a depth-indented outline for
 * the `kmagent subtree` CLI default.
 *
 * Lives in its own module (not inline in `cli.ts`) so it's unit-testable
 * — importing `cli.ts` would run the CLI entrypoint. The invariant it
 * pins is the reason this code exists: the subtree array arrives already
 * in pre-order with siblings in `(order_key, id)` order (the runtime's
 * `SUBTREE_SQL` sorts by path), so it is rendered top-to-bottom verbatim
 * and MUST NOT be re-sorted. A consumer that re-sorted siblings with
 * `localeCompare` once silently inverted an outline's meaning.
 */

/** One node of the flat `get-subtree` result we read for the outline.
 *  The wire payload carries the full `BlockData`; the outline only needs
 *  these three fields. */
export interface SubtreeOutlineRow {
  id: string
  parentId: string | null
  content: string
}

const isSubtreeOutlineRow = (value: unknown): value is SubtreeOutlineRow =>
  typeof value === 'object'
  && value !== null
  && typeof (value as {id?: unknown}).id === 'string'

/**
 * Render the flat `get-subtree` array as a depth-indented outline.
 *
 * Depth is a single pass over the given order: the root is depth 0, and
 * every other row's parent has already appeared (pre-order guarantees
 * it), so `depth = parentDepth + 1`. Same approach as the in-app
 * clipboard serializer (`src/utils/copy.ts`). We never re-sort.
 *
 * Each line is `<indent>- <content>  [<id>]` — content for reading, id
 * for acting (get-block / update-block / …). Multi-line content keeps
 * its continuation lines indented under the bullet; the id stays on the
 * first line.
 */
export const renderSubtreeOutline = (value: unknown): string => {
  if (!Array.isArray(value)) {
    // Unexpected shape (e.g. an error envelope leaked through) — fall
    // back to raw JSON rather than silently printing nothing.
    return JSON.stringify(value, null, 2)
  }
  const rows = value.filter(isSubtreeOutlineRow)
  if (rows.length === 0) return '(empty subtree)'

  const depthById = new Map<string, number>()
  const lines = rows.map((row, index) => {
    const depth = index === 0
      ? 0
      : (depthById.get(row.parentId ?? '') ?? 0) + 1
    depthById.set(row.id, depth)
    const indent = '  '.repeat(depth)
    const content = typeof row.content === 'string' ? row.content : ''
    const [first = '', ...rest] = content.split('\n')
    const head = `${indent}- ${first}  [${row.id}]`
    // Continuation lines of a multi-line block hang under the bullet; the
    // id stays on the first line.
    return rest.length === 0
      ? head
      : `${head}\n${rest.map(line => `${indent}  ${line}`).join('\n')}`
  })
  return lines.join('\n')
}
