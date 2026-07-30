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
 * The control-character/format-character space this module treats as
 * hostile in CONTENT and the rendered PROPERTIES (see `ID_ENCODE_REGEX`
 * further below for `id`'s DIFFERENT, categorical treatment — prose and
 * identifiers need different rules; both are explained where they live):
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
 *  - Every codepoint the Unicode `Bidi_Control` PROPERTY covers — matched
 *    via `\p{Bidi_Control}`, not an enumerated range of codepoints. PR
 *    #447 review comment 3677343389 (the "Trojan Source" class,
 *    CVE-2021-42574): a bidi override/isolate inside content is rendered
 *    unchanged by a bidi-aware terminal or text viewer, which can
 *    visually REORDER the `[id]` token, its closing delimiter, and
 *    adjacent text — defeating the "id comes first, unambiguously" claim
 *    this module exists to make, even though not a single BYTE of the
 *    underlying string moved. That fix originally hand-enumerated the
 *    property's membership — LRM/RLM (U+200E/U+200F), the embedding/
 *    override pair-formers LRE/RLE/PDF/LRO/RLO (U+202A–U+202E), and the
 *    isolate formers LRI/RLI/FSI/PDI (U+2066–U+2069) — the same way the
 *    id-side fix (below) originally did before ITS switch to the
 *    categorical `\p{C}` boundary. PR #447 review comment 3677564794
 *    found that hand-copy had independently omitted U+061C ARABIC LETTER
 *    MARK, a `Bidi_Control` member exactly as reordering-capable as the
 *    eleven that were listed — matching the property directly instead of
 *    a transcription of its membership closes that class of gap by
 *    construction: the transcription can drift from the standard,
 *    `\p{Bidi_Control}` cannot.
 *
 * DELIBERATELY NOT neutralized here: ZERO WIDTH JOINER (U+200D) and ZERO
 * WIDTH NON-JOINER (U+200C). Both are Unicode category Cf (format), same
 * as the bidi controls above — but `\p{Bidi_Control}` does NOT include
 * either, so excluding them from neutralization here isn't a carve-out
 * this module has to maintain by hand; it falls out of matching the
 * narrower, correctly-scoped property instead of the broader `\p{C}`/
 * `\p{Cf}`. Unlike the bidi controls above, NEITHER ZWJ nor ZWNJ reorders
 * anything — they only affect how ADJACENT characters are shaped/combined
 * in place. ZWJ is how compound emoji are built (a family or profession
 * emoji is several codepoints joined by ZWJ; strip it and they fall apart
 * into separate emoji). ZWNJ is semantically REQUIRED orthography in
 * Persian, Hindi, and other scripts that use it to prevent letters from
 * ligating. Stripping either would corrupt real user content to defend
 * against a risk they don't create. The accepted residual this leaves: an
 * invisible-but-NON-reordering character can still appear in rendered
 * prose (ZWJ/ZWNJ here, and Cf format characters outside `Bidi_Control`
 * this module doesn't neutralize at all, e.g. U+00AD SOFT HYPHEN) —
 * that's a display-fidelity/steganography concern, not the anti-forgery
 * one this module defends against, and is out of scope for the SAME
 * reason blanket-`\p{C}`-stripping prose would be the wrong fix: it
 * damages legitimate text to close a risk that doesn't exist for those
 * characters.
 *
 * INVARIANT: no character that can forge a line break or REORDER
 * displayed text reaches the terminal (or an LLM reading the raw outline
 * text) through CONTENT or PROPERTIES. This invariant used to be a
 * character-by-character (or, for one round, character-PROPERTY-member-
 * by-member) deny-list end to end, widened six times now as each round's
 * fix revealed the next character, character CLASS, or — this round —
 * missed MEMBER of a class already thought closed: first LF/CR/VT/FF,
 * then ESC plus the C0 information separators (FS/GS/RS/US), then the
 * rest of the C1 range, then backspace (U+0008: PR #447 review comment
 * 3676752551 — enough backspaces walk the terminal cursor back over the
 * real `- [id] ` prefix and overwrite it), then the bidi-reordering set
 * as a hand-enumerated range (PR #447 review comment 3677343389), and now
 * — PR #447 review comment 3677564794 — that hand-enumerated bidi range
 * itself replaced by the semantic `\p{Bidi_Control}` property after it
 * turned out to already be missing a member (U+061C) on day one.
 * Enumerating hostile characters, OR hostile PROPERTY MEMBERS, one at a
 * time is a losing game: there is always one more nobody thought to name
 * — which is why the bidi hazard class now matches the Unicode property
 * that defines it rather than a transcription of that property's current
 * membership. The C0/C1/DEL/line-separator portion of this space remains
 * a hand-enumerated range: unlike the bidi set, none of those has a
 * single built-in Unicode property matching exactly this module's
 * TAB-excluded, Zl/Zp-inclusive boundary (see the TAB paragraph below,
 * and `ID_ENCODE_REGEX`'s doc comment for why U+2028/U+2029 need listing
 * explicitly even under `id`'s categorical approach), so there's no
 * equivalent categorical swap available for that portion the way there
 * was for bidi.
 *
 * TAB (U+0009) is the one deliberate exclusion from the control-character
 * portion of this space. Unlike every other character in it, a
 * terminal's response to TAB is to advance the cursor FORWARD to the next
 * tab stop — it can never move the cursor backward over already-printed
 * text (the backspace/CSI-cursor-motion hazard part of this module
 * defends against), and no parser this module defends against treats it
 * as a line break either.
 *
 * Expressed as two regex literals rather than one shared constant:
 * `CONTROL_CHAR_RUN_REGEX` is `+`-quantified to collapse a RUN of these to
 * a single marker; `ID_ENCODE_REGEX` (further below) is a DIFFERENT,
 * broader, categorical pattern — see its doc comment for why `id` can't
 * reuse this one. As of this fix, NEITHER regex in this module contains a
 * hand-maintained list of hostile Unicode FORMAT characters: `id` bounds
 * its whole hazard space by the `\p{C}` category (plus the grammar/
 * separator additions `ID_ENCODE_REGEX`'s own doc comment explains), and
 * content bounds its bidi-reordering hazard by the `\p{Bidi_Control}`
 * property, layered on top of the C0/C1/DEL/line-separator range that
 * remains this module's one hand-enumerated character span (a plain
 * control-character range with no format-character hazard, and so no
 * matching Unicode property the way bidi controls have one). */
// eslint-disable-next-line no-control-regex -- intentional control-char match
const CONTROL_CHAR_RUN_REGEX = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]+/gu

/** The lossy neutralization pass applied to CONTENT and the rendered
 *  `properties` JSON: both are prose, not identifiers, so collapsing every
 *  run of hostile characters (see {@link CONTROL_CHAR_RUN_REGEX} and the
 *  invariant stated in its doc comment above) to a single `⏎` marker is an
 *  acceptable — if lossy — way to guarantee one block renders as exactly
 *  one line with no reordering. `id` does NOT go through this function;
 *  see `encodeOutlineId` below for why a lossy collapse is wrong for
 *  identifiers (PR #447 review comment 3676752546). */
const neutralizeOutlineField = (text: string): string =>
  text.replace(CONTROL_CHAR_RUN_REGEX, ' ⏎ ')

/**
 * `id`'s hostile-character boundary — DELIBERATELY NOT the same regex as
 * `CONTROL_CHAR_RUN_REGEX` above, and not another enumerated range. PR
 * #447 review comment 3677343389: this module's control-character deny-
 * list had already been widened four times (LF/CR/VT/FF, then ESC/C0
 * separators, then the rest of C1, then backspace) before a reviewer
 * found that Unicode BIDI FORMATTING CONTROLS — category Cf, a category
 * this deny-list never covered — can reorder the displayed `[id]` token
 * without changing a single byte. Naming that one more range would just
 * be a FIFTH deny-list entry, with a sixth, seventh, ... still findable
 * by the next reviewer who thinks of the next rendering-relevant Unicode
 * category. `id` gets a categorical fix instead: percent-encode
 * `\p{C}` — EVERY codepoint in Unicode General_Category "Other"
 * (Cc control, Cf format, Cs surrogate, Co private-use, Cn unassigned) —
 * plus the two characters outside `\p{C}` that are still hostile to an
 * id specifically: `%` (for the encoding itself to be injective — see
 * `encodeOutlineId` below) and `]` (for the surrounding OUTLINE GRAMMAR
 * — `- [<id>] <content>` — to stay unambiguous; PR #447 review comment
 * 3677029933) and the two Unicode line/paragraph separators U+2028/
 * U+2029 (category Zl/Zp, NOT part of `\p{C}` — General_Category "Other"
 * and "Separator" are siblings, not overlapping, so these must be listed
 * explicitly or this module's round-2 line-separator fix would silently
 * regress for `id` specifically).
 *
 * This makes the id invariant "no character outside printable content
 * survives" — a category BOUNDARY, not a list of specific codepoints.
 * TAB (U+0009) is deliberately NOT exempted here despite the content-side
 * allowance above: `id` is percent-encoded losslessly regardless of which
 * character it is, so there is no reason to carve out an exception for
 * TAB the way there is for prose — keeping the category boundary total
 * (no exceptions) is simpler and can't be defeated by naming a character
 * that "should have" been exempt but wasn't. Whether this categorical
 * boundary genuinely closes the class for `id` — vs. content, whose
 * bidi-reordering hazard is now ALSO categorical (`\p{Bidi_Control}`, see
 * `CONTROL_CHAR_RUN_REGEX`'s doc comment above) but whose C0/C1/DEL/
 * line-separator range is still a hand-enumerated residual — is exactly
 * the question a reviewer should keep pressure-testing (see this module's
 * git history for the six rounds it took to get even this far); the
 * honest answer as of this fix is "it closes every rendering- or
 * terminal-relevant Unicode category we could find," which is a narrower
 * claim than "it closes the class forever." */
const ID_ENCODE_REGEX = /\p{C}|[\u2028\u2029%\]]/gu

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
 * `]` MUST be encoded too, for a related but DISTINCT reason: injectivity
 * of this function ALONE doesn't make the surrounding OUTLINE GRAMMAR
 * unambiguous. `renderSubtreeOutline` embeds the encoded id as
 * `- [<id>] <content>`, so a raw `]` inside the id is indistinguishable
 * from the delimiter that closes it — PR #447 review comment 3677029933:
 * `id: "a] b", content: "c"` and `id: "a", content: "b] c"` both used to
 * render `- [a] b] c`, so a consumer had no way to tell where the id
 * token ends, and therefore no way to even extract the right substring
 * to hand to `decodeOutlineId`.
 *
 * THE PARSING RULE THIS MODULE COMMITS TO, and which encoding `]` is what
 * makes well-defined: the id token is everything between the leading
 * `- [` and the FIRST `]` that follows — a first-match scan, NOT
 * bracket-matching. That rule is unambiguous once every literal `]` that
 * could appear IN the id is guaranteed encoded away, since the first raw
 * `]` byte on the line is then guaranteed to be the structural delimiter.
 * Any consumer that parses the outline back into ids MUST follow this
 * exact rule (see the whole-grammar round-trip/injectivity fuzz
 * properties in subtreeOutline.fuzz.test.ts, which pin it).
 *
 * `[` is deliberately NOT encoded: under the first-`]` rule above, a
 * literal `[` inside the id is inert — it's never treated as an opening
 * delimiter to match, so it can't shift where the id token ends.
 * Encoding it would only matter for a bracket-MATCHING parser, which
 * this module does not assume and does not ask consumers to implement.
 *
 * Uses `encodeURIComponent` — standard percent-encoding of a value's UTF-8
 * bytes — on each matched character rather than a bespoke hex scheme, so
 * the encoding is the one any consumer already knows how to reverse (e.g.
 * `a\nb` → `a%0Ab`).
 *
 * One wrinkle `neutralizeOutlineField` never has to handle: `ID_ENCODE_
 * REGEX`'s `\p{C}` legitimately matches a LONE (unpaired) UTF-16
 * surrogate (U+D800–U+DFFF matched on its own — category Cs) — but
 * `encodeURIComponent` CANNOT represent one as UTF-8 and throws
 * `URIError: URI malformed`, since there's no valid byte sequence for an
 * isolated surrogate code unit. JS strings are unvalidated UTF-16, so a
 * caller-supplied id can genuinely contain one, and `encodeOutlineId`
 * must not throw for it either — that would trade a display-forgery bug
 * for a crash, which is worse. Falls back to a `%uXXXX` escape (the same
 * convention the deprecated global `escape()` used for exactly this: a
 * raw UTF-16 CODE UNIT, not a UTF-8 byte) when `encodeURIComponent`
 * throws — reachable ONLY for a lone surrogate, since a PROPERLY paired
 * surrogate pair is a single valid codepoint `\p{C}` matches as ONE
 * two-code-unit run (`u`-flag regex semantics) that `encodeURIComponent`
 * handles fine. Mixing `%uXXXX` with standard `%XX` escapes in the same
 * output is unambiguous: every `%` `encodeURIComponent` emits is followed
 * by exactly two UPPERCASE hex digits (0-9A-F), never `u`, and every
 * OTHER `%` in the output is one WE just escaped from a literal `%` in
 * the input (always to `%25`, never bare) — so a literal `%` immediately
 * followed by literal text that happens to look like `uD800` still
 * encodes unambiguously (`%` → `%25`, then `uD800` passes through
 * untouched, never producing adjacent `%` + `u`). `decodeOutlineId`
 * reverses this explicitly. */
const encodeOutlineId = (id: string): string =>
  id.replace(ID_ENCODE_REGEX, char => {
    try {
      return encodeURIComponent(char)
    } catch {
      return `%u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    }
  })

/** Exact inverse of {@link encodeOutlineId}. Takes the id token ITSELF —
 *  everything between the leading `- [` and the first `]` that follows,
 *  per the parsing rule documented on {@link encodeOutlineId} — not a raw
 *  outline line.
 *
 *  Not a bare `decodeURIComponent` call: it must also reverse the
 *  `%uXXXX` lone-surrogate escape `encodeOutlineId` falls back to (see
 *  its doc comment) — `decodeURIComponent` only understands 2-hex-digit
 *  `%XX` UTF-8 byte escapes and throws on `%u...`. Splits the string
 *  around `%uXXXX` tokens (provably unambiguous — see `encodeOutlineId`'s
 *  doc comment for why `%u` can only ever appear here as this escape),
 *  reconstructing each raw code unit directly and running the standard
 *  decoder on everything in between. Degenerates to a single
 *  `decodeURIComponent` call when there's no such token, which is the
 *  common case.
 *
 *  Exported as the documented inverse for anyone parsing the TEXT outline
 *  back into ids — but as of PR #447 review comment 3677190043, it has NO
 *  in-tree caller. `kmagent subtree`'s default output and the `subtree`
 *  MCP tool both only ever DISPLAY this text; neither they nor the CLI's
 *  `get-block`/`update-block`/`delete-block` commands or the MCP
 *  `get_block`/`update_block`/`delete_block` tools call this — those
 *  forward whatever id string they're given straight to the bridge
 *  unchanged. See {@link renderSubtreeOutline}'s doc comment for the
 *  display-vs-addressable-surface split this implies, why decoding is
 *  deliberately NOT wired in at those command boundaries, and issue #456
 *  for the durable fix (reject hostile ids at creation). */
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
 * lines that masquerade as child bullets, forge a fake id, or (PR #447
 * review comment 3677343389) visually REORDER the id/delimiter/content
 * via a bidi control: line count == block count AND display order ==
 * byte order. `id` is just as attacker-reachable as content (e.g. an
 * explicit `id` forwarded through `createBlock`), but since it's an
 * IDENTIFIER rather than prose it goes through `encodeOutlineId` (a
 * reversible, injective, CATEGORICAL percent-encoding — `\p{C}` plus
 * grammar characters, not an enumerated list) instead of `content`/
 * `properties`'s lossy, enumerated `neutralizeOutlineField` collapse —
 * see `encodeOutlineId`'s doc comment for why that distinction matters
 * and `ID_ENCODE_REGEX`'s for why `id` gets the categorical treatment.
 *
 * ADDRESSABILITY (PR #447 review comment 3677190043): this text outline
 * is a DISPLAY surface, hardened against forgery by everything above —
 * it is NOT wired up to be addressable. Nothing at the CLI/MCP command
 * boundaries decodes an `[id]` token copied out of it, so for a block
 * whose id needed encoding, that token cannot be pasted into
 * `get-block`/`update-block`/`delete-block` (CLI) or `get_block`/
 * `update_block`/`delete_block` (MCP) — those forward whatever string
 * they're given straight to the bridge, unchanged. Blanket-decoding at
 * those boundaries was considered and rejected: a legitimate id
 * containing a literal `%` is indistinguishable from an encoded token,
 * so decoding unconditionally would CORRUPT real ids.
 *
 * The addressable surface for such a block is `kmagent subtree --json`
 * (cli.ts), which bypasses this renderer entirely — its `--json` branch
 * prints the RAW flat array straight from the bridge, never through
 * `renderSubtreeOutline`, so ids there are exactly what's stored. The
 * `subtree` MCP tool (mcpServer.ts) has NO equivalent raw/structured
 * path today — it only ever returns this rendered text — so an
 * MCP-only consumer currently has no way to address a block whose id
 * needed encoding here; that gap is tracked in issue #456, not fixed in
 * this module. The durable fix is rejecting such ids at block-creation
 * time (also issue #456) — this module only hardens the DISPLAY of ids
 * that already exist, it doesn't make them addressable.
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
