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
 * The full control-character space this module treats as hostile in an
 * interpolated field — shared by `neutralizeOutlineField` (below, applied
 * to CONTENT and the rendered PROPERTIES) and `encodeOutlineId` (further
 * below, applied to `id`) so "hostile" means the same set of characters on
 * every field:
 *
 *  - ALL of C0 (U+0000–U+001F) — every ASCII control code, not an
 *    enumerated subset of them — EXCEPT TAB (U+0009, see the allowance
 *    below).
 *  - DEL (U+007F).
 *  - ALL of C1 (U+0080–U+009F) — ESC's 8-bit-equivalent introducers,
 *    which includes NEL (U+0085).
 *  - The two Unicode line/paragraph separators, U+2028/U+2029, which sit
 *    outside both ASCII ranges but are still read as a line break by many
 *    parsers (and left un-escaped by `JSON.stringify`).
 *
 * INVARIANT: no control character reaches the terminal (or an LLM reading
 * the raw outline text) through ANY interpolated field. This invariant
 * used to be a character-by-character deny-list, widened three times as
 * each round's fix revealed the next character an attacker could still
 * reach — first LF/CR/VT/FF, then ESC plus the C0 information separators
 * (FS/GS/RS/US), then the rest of the C1 range — and most recently
 * backspace (U+0008: PR #447 review comment 3676752551 — enough
 * backspaces walk the terminal cursor back over the real `- [id] ` prefix
 * and overwrite it). Enumerating hostile characters one at a time is a
 * losing game: there is always one more nobody thought to name. Matching
 * the ENTIRE control-character space by construction closes that gap —
 * there is no character left to forget.
 *
 * TAB (U+0009) is the one deliberate exclusion from that space. Unlike
 * every other character above, a terminal's response to TAB is to advance
 * the cursor FORWARD to the next tab stop — it can never move the cursor
 * backward over already-printed text (the backspace/CSI-cursor-motion
 * hazard this module defends against), and no parser this module defends
 * against treats it as a line break either.
 *
 * Expressed as two regex literals rather than one shared constant:
 * `CONTROL_CHAR_RUN_REGEX` is `+`-quantified to collapse a RUN of these to
 * a single marker, while `ID_ENCODE_REGEX` (further below) matches one
 * character at a time so each can be percent-encoded individually. Both
 * enumerate the SAME character ranges — keep them in sync if this set
 * ever changes. */
// eslint-disable-next-line no-control-regex -- intentional control-char match
const CONTROL_CHAR_RUN_REGEX = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]+/g

/** The lossy neutralization pass applied to CONTENT and the rendered
 *  `properties` JSON: both are prose, not identifiers, so collapsing every
 *  run of hostile control characters (see {@link CONTROL_CHAR_RUN_REGEX}
 *  and the invariant stated in its doc comment above) to a single `⏎`
 *  marker is an acceptable — if lossy — way to guarantee one block renders
 *  as exactly one line. `id` does NOT go through this function; see
 *  `encodeOutlineId` below for why a lossy collapse is wrong for
 *  identifiers (PR #447 review comment 3676752546). */
const neutralizeOutlineField = (text: string): string =>
  text.replace(CONTROL_CHAR_RUN_REGEX, ' ⏎ ')

/** Single-character (non-`+`-quantified) variant of
 *  {@link CONTROL_CHAR_RUN_REGEX}, plus `%` itself — see `encodeOutlineId`
 *  below for why `%` must also be matched for the encoding to be
 *  injective. */
// eslint-disable-next-line no-control-regex -- intentional control-char match
const ID_ENCODE_REGEX = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029%]/g

/**
 * Percent-encode the hostile bytes in a block `id` — REVERSIBLY, unlike
 * `neutralizeOutlineField`'s lossy `⏎` collapse. An id is not prose: it's
 * the token a CLI user or an MCP-connected agent copies back out of the
 * outline to address the SAME block via `get-block`/`update-block`/
 * `delete-block`. Collapsing it lossily (the previous behavior) broke that
 * in two distinct ways (PR #447 review comment 3676752546):
 *
 *  - `a\nb` rendered as `a ⏎ b`, which is not `a\nb` — copying it back out
 *    no longer addresses the original block at all.
 *  - Two DISTINCT ids that differ only in which hostile byte they contain
 *    (e.g. `a\nb` vs. `a\rb`) could collapse to the SAME displayed token
 *    (`a ⏎ b` either way), making the outline ambiguous about which block
 *    a given line even refers to.
 *
 * Percent-encoding fixes both: it's a byte-for-byte reversible transform
 * — `decodeOutlineId` is the exact inverse, i.e.
 * `decodeOutlineId(encodeOutlineId(id)) === id` for every `id` — and it's
 * INJECTIVE (two distinct ids can never render the same token). That
 * injectivity is exactly why `%` itself must ALSO be encoded: without
 * that, an id containing the literal three characters `%0A` and an id
 * containing an actual LF byte would both render as `%0A`, collapsing two
 * distinct ids onto one token — the same bug this function exists to fix,
 * just moved from control characters onto `%`.
 *
 * Uses `encodeURIComponent` — standard percent-encoding of a value's UTF-8
 * bytes — on each matched character rather than a bespoke hex scheme, so
 * the encoding is the one any consumer already knows how to reverse (e.g.
 * `a\nb` → `a%0Ab`). */
const encodeOutlineId = (id: string): string =>
  id.replace(ID_ENCODE_REGEX, encodeURIComponent)

/** Exact inverse of {@link encodeOutlineId}. Exported so a consumer that
 *  copies an `[id]` token out of the outline — or this module's own tests
 *  — can recover the original id without re-deriving the encoding scheme. */
export const decodeOutlineId = (encoded: string): string => decodeURIComponent(encoded)

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
 * real id is expected; content (for reading) follows. EVERY field is
 * neutralized before interpolation, so a block can't spill into id-less
 * lines that masquerade as child bullets or forge a fake id: line count ==
 * block count. `id` is just as attacker-reachable as content (e.g. an
 * explicit `id` forwarded through `createBlock`), but since it's an
 * IDENTIFIER rather than prose it goes through `encodeOutlineId` (a
 * reversible, injective percent-encoding) instead of `content`/
 * `properties`'s lossy `neutralizeOutlineField` collapse — see
 * `encodeOutlineId`'s doc comment for why that distinction matters.
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
    const id = encodeOutlineId(row.id)
    const props = options.includeProperties
      && row.properties && typeof row.properties === 'object' && Object.keys(row.properties).length > 0
      ? ` ${neutralizeOutlineField(JSON.stringify(row.properties))}`
      : ''
    return `${indent}- [${id}] ${oneLine}${props}`
  })
  return lines.join('\n')
}
