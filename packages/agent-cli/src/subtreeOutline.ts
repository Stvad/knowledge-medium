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
 *  The wire payload carries the full `SubtreeRow`; the outline only needs
 *  these. `depth` is the authoritative root-relative depth the runtime
 *  computed (0 at the root); `parentId` is only a fallback for deriving
 *  depth if `depth` is ever absent. `properties` is rendered only when the
 *  caller opts in (`includeProperties`). */
export interface SubtreeOutlineRow {
  id: string
  parentId: string | null
  content: string
  depth?: number
  properties?: Record<string, unknown>
}

export interface RenderSubtreeOptions {
  /** Append each block's properties as compact JSON after its content.
   *  Off by default so existing callers (and the human `subtree` CLI)
   *  keep the lean id+content outline. */
  includeProperties?: boolean
}

const isSubtreeOutlineRow = (value: unknown): value is SubtreeOutlineRow =>
  typeof value === 'object'
  && value !== null
  && typeof (value as {id?: unknown}).id === 'string'

const isDepth = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** SUBTREE_SQL caps recursion at depth < 100, so real rows never exceed
 *  that. Clamp the indent anyway: `renderSubtreeOutline` is exported and
 *  pure, and an out-of-range `depth` on a direct call must not blow up
 *  `String.prototype.repeat` (OOM, or RangeError past 2**53). */
const MAX_OUTLINE_DEPTH = 100

/**
 * The single neutralization pass applied to EVERY interpolated field —
 * `id`, `content`, and the rendered `properties` JSON — so the invariant
 * this module exists to guarantee holds everywhere at once: what the
 * terminal (or an LLM reading the raw text) sees is exactly one line per
 * block, id-first, and nothing an attacker/LLM-controlled field can
 * contribute is able to forge a different id or an extra bullet.
 *
 * Two character families are neutralized in one pass, both collapsed to
 * the same `⏎` marker:
 *
 *  - Vertical motion: LF, CR, VT, FF, the C0 information separators
 *    FS/GS/RS/US (U+001C–U+001F), plus NEL/LS/PS (U+0085/U+2028/U+2029) —
 *    every character a terminal, a `splitlines`-style parser, or an LLM
 *    reading the outline may treat as a line break.
 *  - ESC (U+001B) and the rest of the C1 control range (U+0080–U+009F,
 *    which already includes NEL) — ESC introduces every ANSI/VT escape
 *    sequence in the 7-bit encoding (e.g. `ESC [ 1 E` = "cursor next
 *    line", which repositions the cursor to fake a second bullet even
 *    though `outline.split('\n')` still counts one line); the C1 codes
 *    are its 8-bit-equivalent introducers. Removing the introducer
 *    defuses the whole sequence — the remaining parameter/final bytes
 *    (e.g. `[1E`) are left behind as inert text.
 *
 * `properties` goes through `JSON.stringify` first, which escapes every
 * char < U+0020 (so ESC/FS/GS/RS/US are already inert there) but NOT
 * U+0080 and up; `content` and `id` are never stringified, so all of the
 * above reach the outline literally and must be collapsed here. */
const neutralizeOutlineField = (text: string): string =>
  // Matching ESC, the C0 separators, and the C1 range is the whole point:
  // neutralize control/escape chars that could forge a line break or a
  // cursor-motion sequence, rather than treat them as innocent text.
  // eslint-disable-next-line no-control-regex -- intentional control-char match
  text.replace(/[\r\n\v\f\u001b-\u001f\u0080-\u009f\u2028\u2029]+/g, ' ⏎ ')

/**
 * Render the flat `get-subtree` array as a depth-indented outline.
 *
 * Depth comes from the authoritative `depth` field the payload carries
 * (SUBTREE_SQL-computed, root-relative). For robustness against any
 * producer that omits it, we fall back to a single pre-order pass over
 * `parentId` (a parent always precedes its children in pre-order, so its
 * depth is already known). We never re-sort.
 *
 * Each block is rendered as exactly ONE line:
 *   `<indent>- [<id>] <content>`            (default)
 *   `<indent>- [<id>] <content> <propsJSON>` (with `includeProperties`)
 * — the id comes first (right after the bullet) so arbitrary content can
 * never push it off the line or forge a second id-shaped token where the
 * real id is expected; content (for reading) follows. Every field —
 * `id` included, since a caller-supplied id is just as attacker-reachable
 * as content (e.g. an explicit `id` forwarded through `createBlock`) — is
 * passed through `neutralizeOutlineField` before interpolation, so a block
 * can't spill into id-less lines that masquerade as child bullets or forge
 * a fake id: line count == block count.
 */
export const renderSubtreeOutline = (value: unknown, options: RenderSubtreeOptions = {}): string => {
  if (!Array.isArray(value)) {
    // Unexpected shape (e.g. an error envelope leaked through) — fall
    // back to raw JSON rather than silently printing nothing.
    return JSON.stringify(value, null, 2)
  }
  const rows = value.filter(isSubtreeOutlineRow)
  // SUBTREE_SQL always emits the root when it exists and isn't deleted, so
  // an empty result means the root is missing or soft-deleted — never a
  // present-but-childless root (that yields one row, the root itself).
  if (rows.length === 0) return '(no blocks — root not found or deleted)'

  const depthById = new Map<string, number>()
  const lines = rows.map((row, index) => {
    const derived = index === 0
      ? 0
      : (depthById.get(row.parentId ?? '') ?? 0) + 1
    const depth = isDepth(row.depth) ? row.depth : derived
    depthById.set(row.id, depth)
    const indent = '  '.repeat(Math.min(depth, MAX_OUTLINE_DEPTH))
    const content = typeof row.content === 'string' ? row.content : ''
    const oneLine = neutralizeOutlineField(content)
    const id = neutralizeOutlineField(row.id)
    const props = options.includeProperties
      && row.properties && typeof row.properties === 'object' && Object.keys(row.properties).length > 0
      ? ` ${neutralizeOutlineField(JSON.stringify(row.properties))}`
      : ''
    return `${indent}- [${id}] ${oneLine}${props}`
  })
  return lines.join('\n')
}
