/*
 * Renders the flat `get-subtree` result as a depth-indented outline for
 * the `kmagent subtree` CLI default.
 *
 * Its own module rather than inline in `cli.ts` so it is unit-testable —
 * importing `cli.ts` would run the CLI entrypoint.
 *
 * INVARIANT: the subtree array arrives already in pre-order with siblings
 * in `(order_key, id)` order (the runtime's `SUBTREE_SQL` sorts by path),
 * so it is rendered top-to-bottom verbatim and MUST NOT be re-sorted —
 * re-sorting siblings silently inverts an outline's meaning.
 */

/** The subset of the flat `get-subtree` row this outline reads (the wire
 *  payload carries the full `SubtreeRow`). `depth` is the authoritative
 *  root-relative depth the runtime computed (0 at the root); `parentId` is
 *  only a fallback for deriving depth when `depth` is absent. */
export interface SubtreeOutlineRow {
  id: string
  parentId: string | null
  content: string
  depth?: number
  properties?: Record<string, unknown>
}

export interface RenderSubtreeOptions {
  /** Append each block's properties as compact JSON after its content.
   *  Off by default so the human `subtree` CLI keeps the lean id+content
   *  outline. */
  includeProperties?: boolean
}

const isSubtreeOutlineRow = (value: unknown): value is SubtreeOutlineRow =>
  typeof value === 'object'
  && value !== null
  && typeof (value as {id?: unknown}).id === 'string'

const isDepth = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** SUBTREE_SQL caps recursion at this depth, so real rows never exceed it.
 *  Clamped anyway as defence in depth: `renderSubtreeOutline` is exported
 *  and pure, and an out-of-range `depth` on a direct call must not blow up
 *  `String.prototype.repeat` (OOM, or RangeError past 2**53). */
const MAX_OUTLINE_DEPTH = 100

/**
 * The characters this module treats as hostile in CONTENT and the rendered
 * PROPERTIES: all of C0 except TAB, DEL, all of C1, U+2028/U+2029, and
 * every codepoint the Unicode `Bidi_Control` property covers. `id` gets a
 * DIFFERENT, categorical treatment — see `ID_ENCODE_REGEX`.
 *
 * INVARIANT: no character that can forge a line break or REORDER displayed
 * text reaches the terminal (or an LLM reading the raw outline text)
 * through content or properties.
 *
 * The bidi class ("Trojan Source": an override or isolate inside content is
 * rendered unchanged by a bidi-aware terminal, which can visually reorder
 * the `[id]` token and its delimiter without a single byte moving) is
 * matched as a Unicode PROPERTY rather than a hand-enumerated transcription
 * of its members, because a transcription can silently omit a member
 * exactly as reordering-capable as the rest. The C0/C1/DEL/line-separator
 * half stays a hand-enumerated range only because no single Unicode
 * property matches this TAB-excluded, Zl/Zp-inclusive boundary.
 *
 * TAB (U+0009) is the one deliberate exclusion: a terminal advances the
 * cursor FORWARD on TAB, so unlike the rest it can never walk back over
 * already-printed text, and no parser here reads it as a line break.
 *
 * ZERO WIDTH JOINER (U+200D) and ZERO WIDTH NON-JOINER (U+200C) are
 * deliberately NOT neutralized, so do not broaden this to `\p{Cf}` or
 * `\p{C}`: neither reorders anything (they shape adjacent characters in
 * place) and both are required in real content — compound emoji are built
 * with ZWJ, and ZWNJ is mandatory orthography in Persian, Hindi and other
 * scripts. Accepted residual: an invisible but NON-reordering character can
 * still reach rendered prose, which is display fidelity rather than the
 * anti-forgery concern defended here.
 */
// eslint-disable-next-line no-control-regex -- intentional control-char match
const CONTROL_CHAR_RUN_REGEX = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]+/gu

/** The lossy neutralization applied to CONTENT and the rendered
 *  `properties` JSON: both are prose, not identifiers, so collapsing each
 *  run of hostile characters (see {@link CONTROL_CHAR_RUN_REGEX}) to a
 *  single marker is an acceptable way to guarantee one block renders as
 *  exactly one line with no reordering. `id` must round-trip instead and
 *  does NOT go through this — see `encodeOutlineId`. */
const neutralizeOutlineField = (text: string): string =>
  text.replace(CONTROL_CHAR_RUN_REGEX, ' ⏎ ')

/**
 * `id`'s hostile-character boundary — a CATEGORY, not an enumerated list,
 * so it cannot be defeated by naming a rendering-relevant character nobody
 * thought of. Percent-encode every `\p{C}` codepoint (Cc control, Cf
 * format, Cs surrogate, Co private-use, Cn unassigned), plus three things
 * outside that category:
 *  - `%`, so the encoding stays injective (see `encodeOutlineId`).
 *  - `]`, so the surrounding `- [<id>] <content>` grammar stays unambiguous.
 *  - U+2028/U+2029, which are Zl/Zp — General_Category "Other" and
 *    "Separator" are siblings, so `\p{C}` does NOT cover these and dropping
 *    them from this list would silently regress line-separator handling for
 *    `id` specifically.
 *
 * TAB is deliberately NOT exempted here the way it is for prose: `id` is
 * percent-encoded losslessly whatever the character, so keeping the
 * category boundary total (no exceptions) costs nothing.
 */
const ID_ENCODE_REGEX = /\p{C}|[\u2028\u2029%\]]/gu

/**
 * Percent-encode the hostile characters in a block `id` — REVERSIBLY,
 * unlike `neutralizeOutlineField`'s lossy collapse. An id is not prose: it
 * is the token a CLI user or an MCP-connected agent copies back out of the
 * outline to address the SAME block. So this transform must be the exact
 * inverse of `decodeOutlineId`, and INJECTIVE — two distinct ids may never
 * render as one token. Injectivity is why `%` itself is encoded: without
 * that, an id containing the literal three characters `%0A` and an id
 * containing an actual LF byte would both render as `%0A`.
 *
 * THE PARSING RULE THIS MODULE COMMITS TO: the id token is everything
 * between the leading `- [` and the FIRST `]` that follows — a first-match
 * scan, NOT bracket-matching. Encoding every `]` is what makes that rule
 * well-defined, since the first raw `]` on the line is then guaranteed to
 * be the structural delimiter. `[` is deliberately left raw: under a
 * first-`]` scan it is inert and cannot shift where the token ends. Any
 * consumer parsing the outline back into ids MUST follow this rule (pinned
 * by the whole-grammar properties in subtreeOutline.fuzz.test.ts).
 *
 * `encodeURIComponent` is used rather than a bespoke hex scheme so the
 * encoding is the one any consumer already knows how to reverse. It throws
 * on a LONE (unpaired) surrogate — `\p{C}` matches one, and UTF-8 has no
 * byte sequence for it — and trading a display-forgery bug for a crash
 * would be worse, hence the `%uXXXX` code-unit fallback. Mixing the two
 * escapes stays unambiguous: every `%` the standard encoder emits is
 * followed by exactly two uppercase hex digits, never `u`, and every other
 * `%` in the output is one we escaped from a literal `%` (always `%25`).
 */
const encodeOutlineId = (id: string): string =>
  id.replace(ID_ENCODE_REGEX, char => {
    try {
      return encodeURIComponent(char)
    } catch {
      return `%u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    }
  })

/** Exact inverse of {@link encodeOutlineId}. Takes the id TOKEN itself —
 *  everything between the leading `- [` and the first `]` that follows, per
 *  the parsing rule on {@link encodeOutlineId} — not a raw outline line.
 *
 *  Not a bare `decodeURIComponent` call: that understands only 2-hex-digit
 *  `%XX` escapes and throws on the `%uXXXX` lone-surrogate fallback, so
 *  those tokens are split out and rebuilt as raw code units first —
 *  unambiguously, for the reason {@link encodeOutlineId} gives.
 *
 *  Exported as the documented inverse for anyone parsing the text outline
 *  back into ids; it has no in-tree caller, because nothing at the CLI/MCP
 *  command boundaries decodes ids (see {@link renderSubtreeOutline}). */
export const decodeOutlineId = (encoded: string): string => {
  const LONE_SURROGATE_ESCAPE = /%u([0-9A-Fa-f]{4})/g
  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = LONE_SURROGATE_ESCAPE.exec(encoded)) !== null) {
    result += decodeURIComponent(encoded.slice(cursor, match.index))
    result += String.fromCharCode(parseInt(match[1], 16))
    cursor = LONE_SURROGATE_ESCAPE.lastIndex
  }
  return result + decodeURIComponent(encoded.slice(cursor))
}

/**
 * Render the flat `get-subtree` array as a depth-indented outline.
 *
 * Depth comes from the payload's authoritative `depth`; when a producer
 * omits it we fall back to one pre-order pass over `parentId` (a parent
 * always precedes its children in pre-order, so its depth is already
 * known).
 *
 * Each block is rendered as exactly ONE line:
 *   `<indent>- [<id>] <content>`             (default)
 *   `<indent>- [<id>] <content> <propsJSON>` (with `includeProperties`)
 * The id comes first, right after the bullet, so arbitrary content can
 * never push it off the line or forge a second id-shaped token where the
 * real id is expected. EVERY field is neutralized before interpolation,
 * which is what gives the rendering invariant: line count == block count
 * AND display order == byte order.
 *
 * ADDRESSABILITY: this outline is a DISPLAY surface, not an addressable
 * one. Nothing at the CLI/MCP command boundaries decodes an `[id]` token
 * copied out of it, so an id that needed encoding cannot be pasted into
 * `get-block`/`update-block`/`delete-block` or their MCP equivalents.
 * Blanket-decoding at those boundaries was considered and rejected: a
 * legitimate id containing a literal `%` is indistinguishable from an
 * encoded token, so decoding unconditionally would CORRUPT real ids. The
 * addressable path is `kmagent subtree --json`, which bypasses this
 * renderer and prints ids exactly as stored; the MCP `subtree` tool has no
 * equivalent. Issue #456 tracks the durable fix — rejecting hostile ids at
 * block-creation time.
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
