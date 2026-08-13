/**
 * Reference parser + renderer for `[[alias]]` and `((block-id))`
 * syntax. Owned by the references plugin — this is the canonical
 * grammar for wikilinks and blockrefs across the codebase.
 *
 * Consumers (outside this plugin): the roam importer reads from
 * here. Anything that emits the syntax should also use the
 * `renderWikilink` / `renderAliasedBlockref` helpers below to avoid
 * drift from parser expectations (`]]` cannot be represented
 * exactly inside wikilink text, `]` / newlines in blockref labels,
 * regex-meta + `$&` in aliases through `rewriteWikilinks`).
 *
 * Plain-text parsing here is preferred over the markdown-aware
 * variant for hot paths; the markdown-aware fallback exists for
 * surfaces that must skip code blocks (see `parseReferencesMarkdownAware`).
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Text } from 'mdast'

export interface ParsedReference {
  alias: string;
  startIndex: number;
  endIndex: number;
}

export interface ParsedBlockRef {
  blockId: string;
  startIndex: number;
  endIndex: number;
  embed: boolean;  // true for !((id)), false for plain ((id))
  /** Display label from `[label](((id)))`. Present (possibly `''` —
   *  the renderer falls back to displaying the id) iff the mark used
   *  the aliased form; absent for plain/embed marks. Rewriters key on
   *  presence to preserve the mark's form. */
  label?: string;
}

// UUIDv4 shape — anchors what counts as a block-ref id. We deliberately keep
// this strict so accidental double-parens in prose (e.g. "((not an id))")
// don't get treated as references.
const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ALIASED_BLOCK_REF_RE = new RegExp(`\\[([^\\]\\n]*)\\]\\(\\(\\((${UUID_RE_SOURCE})\\)\\)\\)`, 'gi')
const BLOCK_REF_RE = new RegExp(`\\(\\((${UUID_RE_SOURCE})\\)\\)`, 'gi')
const BLOCK_EMBED_RE = new RegExp(`!\\(\\((${UUID_RE_SOURCE})\\)\\)`, 'gi')
const BLOCK_REF_TARGET_RE = new RegExp(`^\\(\\((${UUID_RE_SOURCE})\\)\\)$`, 'i')

export const isBlockRefId = (s: string) => new RegExp(`^${UUID_RE_SOURCE}$`, 'i').test(s)

export const parseBlockRefTarget = (target: string): string | null => {
  const match = BLOCK_REF_TARGET_RE.exec(target.trim())
  return match ? match[1].toLowerCase() : null
}

/** Longest alias a `[[…]]` span may carry and still count as a wikilink.
 *  A longer span is scanned past and emits no reference — the text stays
 *  literal, and no page is minted for it.
 *
 *  A runaway guard, not a style rule. Nothing in this grammar bounds how
 *  far a `[[` may reach for its `]]`, and any text carrying CODE supplies
 *  unbalanced openers for free: a regex character class whose first member
 *  is a literal `[` (`/[[\]{}()*+?.\\^$|\s]/`) is a `[[`, and so is a
 *  nested array literal (`[[1,2],[3,4]]`). One such opener inside a
 *  bundled extension's source paired with a `]]` 205 KB downstream — the
 *  scanner is indifferent to the distance — and minted a page whose NAME
 *  was 205 KB of JavaScript, carried from there into the alias index,
 *  backlink panes, search and sync.
 *
 *  Calibrated against live data: across ~31k aliases in the author's
 *  workspace the longest human-authored one is 322 chars (a multi-line
 *  quoted question used as a page title). 4096 is deliberately far above
 *  that — this is a blast-radius bound on a runaway, not a judgement
 *  about how long a page name ought to be, so it is set where "no human
 *  typed this" is beyond argument. The cost of the generous setting is
 *  explicit: junk aliases in the low thousands (a 2951-char drawing
 *  point-array in this very workspace) stay under it and are NOT caught.
 *  Only the catastrophic tail is.
 *
 *  Deliberately here in the parser and not in the reference processor:
 *  both the index and the renderer reach the cap through this function,
 *  so a processor-only cap would render a live-looking link the reference
 *  index knows nothing about. `remark-wikilinks` passes 3 and 4 inherit
 *  the cap by calling `parseOutermostReferences`; passes 1 and 2 match
 *  their own regexes and so re-check it explicitly.
 *
 *  One rule, but NOT one string, and the difference is worth stating
 *  plainly. The index parses RAW `blocks.content`; the renderer parses
 *  what `remark-parse` produced, which has already resolved markdown
 *  backslash escapes. So `[[a\.b]]` is measured (and stored) as `a\.b`
 *  by the index while the renderer binds `a.b` — and an escaped span can
 *  therefore sit over the cap raw and under it decoded (2148 × `\.` is
 *  4296 raw, 2148 decoded). That divergence is NOT created by this cap:
 *  it applies to the alias VALUE at every length, predates this constant,
 *  and is already documented at `faithfulWikilinkReplacement`, which
 *  refuses backslash aliases for exactly this reason. The cap does not
 *  worsen it either — decoding only ever shortens, so an escaped span can
 *  cross the threshold in one direction only, and the effect there is to
 *  stop minting a phantom page for a link that rendered unresolved either
 *  way. Closing it for real means parsing the index side through markdown
 *  too, which is issue #542. */
export const MAX_ALIAS_LENGTH = 4096

const parseWikilinkReferences = (content: string): ParsedReference[] => {
  const references: ParsedReference[] = []
  const stack: number[] = [] // Stack to track opening bracket positions
  let i = 0

  while (i < content.length - 1) {
    if (content.slice(i, i + 2) === '[[') {
      stack.push(i)
      i += 2
    } else if (content.slice(i, i + 2) === ']]') {
      if (stack.length > 0) {
        const startPos = stack.pop()!
        const alias = content.slice(startPos + 2, i)
        // Gate EMISSION only — the pop above still happened, so a
        // rejected span consumes its delimiters exactly as an accepted
        // one does. Leaving the opener on the stack instead would let it
        // pair with a `]]` even further downstream, which is the failure
        // mode this cap exists to end rather than relocate.
        if (alias && alias.length <= MAX_ALIAS_LENGTH) {
          references.push({
            alias,
            startIndex: startPos,
            endIndex: i + 2,
          })
        }
      }
      i += 2
    } else {
      i++
    }
  }

  // Sort references by start position
  return references.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Parse every balanced `[[alias]]` pattern from text content. Nested
 * wikilinks emit both the outer and inner references, matching Roam's
 * backlink behavior.
 */
export function parseReferences(content: string): ParsedReference[] {
  return parseWikilinkReferences(content)
}

/**
 * Parse only the outermost balanced `[[alias]]` spans. Use this when a
 * caller needs token boundaries for text rewriting/rendering, where
 * overlapping nested spans would corrupt slicing.
 */
export function parseOutermostReferences(content: string): ParsedReference[] {
  const references = parseWikilinkReferences(content)
  const outermost: ParsedReference[] = []
  let cursor = 0
  for (const ref of references) {
    if (ref.startIndex < cursor) continue
    outermost.push(ref)
    cursor = ref.endIndex
  }
  return outermost
}

/**
 * Parse references using remark for markdown-aware extraction
 * This version respects markdown structure (ignores code blocks, etc.)
 */
export function parseReferencesMarkdownAware(content: string): ParsedReference[] {
  const references: ParsedReference[] = []

  try {
    const tree = unified()
      .use(remarkParse)
      .parse(content)

    visit(tree, 'text', (node: Text, _index, parent) => {
      // Skip if we're inside a code block or inline code
      if (['code', 'inlineCode'].includes(parent?.type as string)) return

      const text = node.value
      // Note: position calculation would need more work for exact positions
      // across markdown nodes. For now, indexes remain relative to this
      // text node, matching the earlier implementation.
      references.push(...parseReferences(text))
    })
  } catch (error) {
    console.warn('Error parsing references:', error)
    // Fallback to regex parsing if remark fails
    return parseReferences(content)
  }

  return references
}

/**
 * Extract just the alias strings from content
 * @param content The text content to parse
 * @returns Array of unique alias strings found
 */
export function extractAliases(content: string): string[] {
  const references = parseReferences(content)
  const uniqueAliases = new Set(references.map(ref => ref.alias))
  return Array.from(uniqueAliases)
}

/**
 * Check if content contains any references
 * @param content The text content to check
 * @returns True if content contains [[alias]] patterns
 */
export function hasReferences(content: string): boolean {
  return parseReferences(content).length > 0
}

/**
 * Parse `((uuid))` block-refs, `!((uuid))` block-embeds, and Roam-style
 * `[label](((uuid)))` aliased block refs out of text. More specific forms are
 * matched first so their inner `((uuid))` spans are not double-counted.
 */
export function parseBlockRefs(content: string): ParsedBlockRef[] {
  const found: ParsedBlockRef[] = []
  const consumed: Array<[number, number]> = []
  const overlapsConsumed = (start: number, end: number) =>
    consumed.some(([s, e]) => start < e && end > s)

  ALIASED_BLOCK_REF_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ALIASED_BLOCK_REF_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    found.push({
      blockId: match[2].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: false,
      // Always present for the aliased form, even when '' — a truthy
      // gate here made `[](((id)))` indistinguishable from `((id))`,
      // so rewriteBlockRefs silently degraded the aliased form to a
      // plain ref (changing display semantics from id-fallback to
      // target content). Found by referenceParser.fuzz.
      label: match[1].trim(),
    })
    consumed.push([start, end])
  }

  BLOCK_EMBED_RE.lastIndex = 0
  while ((match = BLOCK_EMBED_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (overlapsConsumed(start, end)) continue
    found.push({
      blockId: match[1].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: true,
    })
    consumed.push([start, end])
  }

  BLOCK_REF_RE.lastIndex = 0
  while ((match = BLOCK_REF_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (overlapsConsumed(start, end)) continue
    found.push({
      blockId: match[1].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: false,
    })
  }

  return found.sort((a, b) => a.startIndex - b.startIndex)
}

export function extractBlockRefIds(content: string): string[] {
  return Array.from(new Set(parseBlockRefs(content).map(r => r.blockId)))
}

// ──── Rendering helpers (centralized so callers don't build wikilink
//      / blockref syntax via string templates and accidentally diverge
//      from parser expectations). ────

/** Render a wikilink targeting `alias`. If `alias` contains wikilink
 *  delimiters (`[[`, `]]`, or a trailing `]`), the output is
 *  syntactically safe but lossy; callers that need alias identity must
 *  verify by parsing the result. Guarantee, for an `alias` that is
 *  non-empty and at most `MAX_ALIAS_LENGTH`: the output always parses to
 *  exactly one outermost reference spanning the whole string, and is
 *  delimiter-balanced so it cannot combine with surrounding text into a
 *  different link.
 *
 *  Two inputs fall outside that guarantee and render markup the parser
 *  emits ZERO references for — `alias === ''` (`[[]]`, stopped by the
 *  `if (alias)` gate) and any alias longer than `MAX_ALIAS_LENGTH`. This
 *  function does not refuse them, because its callers split into two
 *  kinds and only one can act on a refusal: the rewriters go through
 *  `faithfulWikilinkReplacement`, which verifies by re-parsing and falls
 *  back to the pinned form on `null`, so they are already safe; the
 *  direct callers are PRODUCERS with a real user at the other end
 *  (`appendTagToContent`), and they owe a check at their own entry point
 *  where the input can still be rejected with an explanation instead of
 *  silently degrading — see `isValidTagName`. */
export const renderWikilink = (alias: string): string => {
  // `]]` inside the alias would terminate the wikilink at the wrong
  // place, and an unclosed `[[` would leak an opener that a later `]]`
  // anywhere in the document could pair with, swallowing unrelated
  // text. Splitting with a space keeps the visible text close to the
  // input, but it no longer parses to the same alias. Lookahead, not
  // pair replacement: replacing the pair `]]` recreates one on odd
  // runs (']]]' → '] ]]') — the space must land between EVERY two
  // adjacent delimiters. Found by referenceParser.fuzz.
  const safe = alias.replace(/\[(?=\[)/g, '[ ').replace(/\](?=\])/g, '] ')
  // A trailing `]` would pair with the closing delimiter's first `]`
  // and close the link one character early, leaving a stray `]`
  // outside the parsed span.
  const padded = safe.endsWith(']') ? safe + ' ' : safe
  return `[[${padded}]]`
}

/** Can `alias` be written as a `[[…]]` span this parser reads back as a
 *  reference at all? False only for spans the grammar refuses outright —
 *  today, over `MAX_ALIAS_LENGTH` measured on the RENDERED span, which is
 *  not the same as the input length: `renderWikilink` pads a trailing `]`
 *  with a space, so an at-cap name ending in `]` emits an alias one over.
 *
 *  The producer-side companion to the cap. Every surface that OFFERS or
 *  WRITES a wikilink on a user's behalf owes this check — the tag entry
 *  points, the `[[` autocomplete — because the alternative is handing
 *  back markup that renders as literal text and gains no backlink, with
 *  nothing on screen saying why.
 *
 *  Deliberately WEAKER than `faithfulWikilinkReplacement`: this asks only
 *  "does a reference come back", not "is it byte-identical". The lossy
 *  cases that already work (a backslash, a trailing `]`) keep working, so
 *  adding this check to a surface cannot newly reject an alias that
 *  surface accepts today. */
export const canRenderAsWikilink = (alias: string): boolean =>
  parseOutermostReferences(renderWikilink(alias)).length === 1

/** Render an aliased blockref `[label](((id)))`. Strips `]` and
 *  newlines from `label` because the parser's regex rejects them in
 *  the label segment (see `ALIASED_BLOCK_REF_RE`). `id` is assumed
 *  to be a UUID — already safe. An empty label (also after stripping)
 *  is allowed — the parser matches `[]` (zero-length label) and the
 *  live renderer then displays the target's content, exactly like a
 *  plain `((id))` (remark-blockrefs emits no display children for an
 *  empty label; only unresolved targets fall back to the short id). */
export const renderAliasedBlockref = (label: string, id: string): string => {
  // Parser regex: `\[([^\]\n]*)\]\(\(\((UUID)\)\)\)`. Anything in `]`
  // or `\n` would break the match; drop them. Empty label after
  // stripping is allowed — the parser matches `[]` (zero-length
  // label) and the renderer falls back to displaying the id.
  const safeLabel = label.replace(/[\]\n]/g, '')
  return `[${safeLabel}](((${id})))`
}

// ──── Whole-span round-trip guard (props-as-blocks §11, group 2) ────
//
// Both renderers above are deliberately lossy-but-SAFE: they mangle
// input that would break the grammar (`renderWikilink` spaces apart
// adjacent delimiters; `renderAliasedBlockref` strips `]` and newlines
// from the label) so the output always PARSES. "Parses" is not "means
// what the author wrote" — and every site that renders a span to
// REPLACE an existing one is trading the author's text for machine
// text, so it owes a proof that the trade preserved both halves of the
// span's meaning: the target it resolves to, and the text it displays.
//
// The guard is that proof: render → parse back through this same
// parser → compare target AND label. Callers get one of three
// outcomes rather than a bare string, because the right fallback
// differs by which half failed (see `SpanReplacement`).

/** A verified replacement for one reference span. */
export interface SpanReplacement {
  /** Literal text to splice in place of the old span. */
  text: string
  /** The alias a re-parse of `text` yields: the alias itself for the
   *  wikilink form, the normalized target id for the pinned form (the
   *  grammar makes an aliased blockref's alias its id). Returned
   *  alongside the text so a rewriter can update content and its stored
   *  edge list in lockstep instead of re-deriving one from the other. */
  refAlias: string
  /** Normalized target id the spliced text actually binds to, when the
   *  replacement PINS to one. `null` for the wikilink form, which is
   *  late-binding and names no id. Callers use it so the stored edge's
   *  `id` and `alias` stay in the same normalization as each other. */
  toTargetId: string | null
  /** True when `text` resolves to the intended target but DISPLAYS
   *  something other than the requested label (`]`/newline stripped,
   *  surrounding whitespace trimmed). The link is intact; the visible
   *  text changed, so callers report it rather than failing. */
  lossyLabel: boolean
}

/** `[[alias]]`, but only when it parses back to exactly this alias and
 *  nothing else. Returns `null` when the wikilink form cannot carry
 *  the alias faithfully — blank (`[[]]` parses to zero references) or
 *  containing delimiters `renderWikilink` has to space apart. There is
 *  no lossy tier here: a wikilink's label IS its target, so a mangled
 *  label is a mangled binding. */
export const faithfulWikilinkReplacement = (alias: string): SpanReplacement | null => {
  // MARKDOWN is a third grammar over this text, and it owns `\` as an
  // escape. The parsers here keep a backslash verbatim, so `[[abc\]]`
  // looks like a clean round trip — but remark resolves `\]` to a literal
  // `]` before `remark-wikilinks` ever sees the text, and the rendered
  // link binds to alias `abc` while the edge we store says `abc\`. The
  // span points somewhere the projection doesn't, which is the exact
  // failure this guard exists to refuse.
  //
  // Refused rather than escaped: doubling the backslash would change the
  // literal alias text, and the caller has a pinned fallback that keeps
  // the TARGET regardless of how markdown treats the label.
  if (alias.includes('\\')) return null
  const text = renderWikilink(alias)
  const marks = parseOutermostReferences(text)
  if (marks.length !== 1) return null
  const [mark] = marks
  if (mark.startIndex !== 0 || mark.endIndex !== text.length) return null
  if (mark.alias !== alias) return null
  return {text, refAlias: alias, toTargetId: null, lossyLabel: false}
}

/** `[label](((targetId)))` — the pinned form, which keeps the display
 *  text the source author wrote while binding to a stable id.
 *
 *  Returns `null` when the rendered span does not parse back to
 *  `targetId`. The aliased form's id segment is UUID-only
 *  (`ALIASED_BLOCK_REF_RE`), so a non-UUID-shaped target fails here —
 *  and that failure MUST NOT be papered over: emitting the text anyway
 *  turns the span into prose and destroys the reference outright.
 *  Callers leave the span alone and report instead.
 *
 *  A label that survives the round-trip only after sanitization comes
 *  back with `lossyLabel: true`. That tier exists because the two
 *  failures are not equally bad: the reference still lands on the
 *  right block, only its visible text changed, and refusing to rewrite
 *  would strand the span on a name nothing claims. */
/** Characters a label carries through our own round trip but that
 *  MARKDOWN re-interprets when it renders the span. See the
 *  `lossyLabel` note in `pinnedSpanReplacement`. */
const MARKDOWN_UNSAFE_LABEL_RE = /[\\[]/

export const pinnedSpanReplacement = (
  label: string,
  targetId: string,
): SpanReplacement | null => {
  const text = renderAliasedBlockref(label, targetId)
  const marks = parseBlockRefs(text)
  // A non-UUID target fails HERE, not on the id comparison below: the
  // grammar simply doesn't match, so the span parses to zero marks.
  if (marks.length !== 1) return null
  const [mark] = marks
  if (mark.startIndex !== 0 || mark.endIndex !== text.length) return null
  // EXACT, not `targetId.toLowerCase()`. The parser canonicalizes
  // UUID-shaped ids to lowercase, so comparing against a pre-lowered
  // target re-states the parser's rule here and certifies a round trip
  // that did not happen: for a caller-supplied upper-case id (`tx.create`
  // and the agent bridge both accept caller ids verbatim, and SQLite
  // compares `blocks.id` case-sensitively) the check would pass while the
  // spliced text and the stored edge bind to a lowercase id no row has.
  // `referenceBlockContentForId` rejects this same divergence on the
  // `((id))` form for the same reason (PR #386 review); a whole-span guard
  // that tolerates it is strictly worse than one that refuses, because the
  // caller then leaves the span alone instead of re-pointing it at nothing.
  if (mark.blockId !== targetId) return null
  // The span must also be INERT under the other grammar sharing this
  // text. `renderAliasedBlockref` strips `]` and newlines but keeps `[`,
  // so a label like `a[[b` renders a perfectly valid aliased blockref
  // that also carries an unbalanced wikilink OPENER. Parsing the span in
  // isolation sees nothing wrong — there's no closing `]]` in it — but
  // splice it into a source with any later `]]` and the pair closes
  // across the spliced text, manufacturing a bogus wikilink that binds a
  // reference and mints a seat. `renderWikilink` already spaces adjacent
  // delimiters apart for exactly this reason; the pinned form can't
  // (its leading `[` is grammar), so it refuses instead.
  //
  // `]]` needs no test: the renderer strips every `]` from the label and
  // the template contributes exactly one, so a closer can't be formed.
  if (text.includes('[[')) return null
  // `refAlias` / `toTargetId` are what a re-parse ACTUALLY yields, so
  // both carry the parser's normalized (lower-cased) id —
  // `parseReferences` emits `{id: mark.blockId, alias: mark.blockId}`
  // for blockref edges. Returning a normalized alias beside an
  // unnormalized id would write an entry pair no re-parse produces, and
  // whose `block_references.target_id` joins nothing.
  // `parseBlockRefs` trims the captured label, so leading/trailing
  // whitespace counts as lossy alongside the stripped characters.
  return {
    text,
    refAlias: mark.blockId,
    toTargetId: mark.blockId,
    // Markdown re-parses this label, and two characters survive our own
    // round trip while changing what it renders:
    //   `\`  escapes the next character, so `abc\` displays as `abc`.
    //   `[`  opens a nested link, so `a[b` splits into literal text `[a`
    //        followed by a link labelled only `b` — the label is
    //        reordered and only its suffix is clickable.
    // (`]` needs no entry: the renderer strips every one.)
    //
    // Reported rather than refused, unlike the wikilink form: the id
    // segment carries the binding either way, so the reference still
    // lands on the right block and only the visible text changes — which
    // is exactly the distinction `lossyLabel` exists to draw.
    lossyLabel: mark.label !== label || MARKDOWN_UNSAFE_LABEL_RE.test(label),
  }
}

/** `[display]([[alias]])` — a wikilink carrying custom display text.
 *
 *  A THIRD span shape the rewriters have to know about, because
 *  `parseReferences` doesn't: it reports only the inner `[[alias]]`, while
 *  `remark-wikilinks` treats the whole wrapper as one wikilink whose
 *  rendered children are `display` (its first pass matches a `link` node
 *  with url `[[alias]]`; its `LINK_FORM_RE` pass catches the same shape
 *  when the alias has spaces and remark therefore never made a link).
 *
 *  Splicing a PINNED replacement into the inner span alone yields
 *  `[display]([label](((uuid))))`, which the real pipeline renders as an
 *  ordinary markdown link whose URL is `[label](((uuid)))` — verified
 *  against `remarkWikilinks` + `remarkBlockrefs`, not assumed. Neither a
 *  wikilink nor a blockref: the reference is destroyed while the stored
 *  edge moves to the target, so content and edge disagree permanently.
 *  (The wikilink→wikilink swap is safe: `[display]([[new]])` is still the
 *  same shape. Only the pinned form has to widen its range.)
 *
 *  `image: true` for `![display]([[alias]])`, which markdown parses as an
 *  IMAGE — it carries no reference at render time even before a rewrite,
 *  so pinned callers step over it exactly as they do a page embed rather
 *  than converting an image into a blockref.
 *
 *  Returns null when the wrapper doesn't match the grammar the renderer
 *  accepts, in which case the inner span is the whole span. */
const linkFormWrapperAround = (
  content: string,
  mark: {startIndex: number; endIndex: number},
): {start: number; end: number; display: string; image: boolean} | null => {
  if (content[mark.endIndex] !== ')') return null
  if (mark.startIndex < 2) return null
  if (content.slice(mark.startIndex - 2, mark.startIndex) !== '](') return null
  const close = mark.startIndex - 2
  const open = content.lastIndexOf('[', close - 1)
  if (open === -1) return null
  const display = content.slice(open + 1, close)
  // Same character class as the renderer's `LINK_FORM_RE` display group.
  // `lastIndexOf` already guarantees no `[`; this rejects `]` and newlines,
  // which would make remark parse something other than one link.
  if (/[[\]\n]/.test(display)) return null
  return {
    start: open,
    end: mark.endIndex + 1,
    display,
    image: open > 0 && content[open - 1] === '!',
  }
}

/** How one alias's spans should be replaced. `pinnedTargetId` is set iff
 *  `text` is the PINNED form `[label](((id)))` — it lets the splice widen
 *  its range over a `[display]([[alias]])` wrapper and re-render with the
 *  author's display text (see `linkFormWrapperAround`). Pinned callers
 *  pass it alongside `skipEmbeds`; both derive from the same
 *  `SpanReplacement.toTargetId`. */
export interface WikilinkRewrite {
  text: string
  skipEmbeds?: boolean
  pinnedTargetId?: string
}

/** The splice range and text for one mark, or `null` to leave it alone.
 *  Shared by both rewriters so the wrapper and embed rules cannot drift
 *  between the rename path and the merge path. */
const spliceFor = (
  content: string,
  mark: {startIndex: number; endIndex: number},
  rewrite: WikilinkRewrite,
): {start: number; end: number; text: string} | null => {
  const pinned = rewrite.pinnedTargetId
  if (pinned !== undefined) {
    const wrapper = linkFormWrapperAround(content, mark)
    if (wrapper !== null) {
      // An image carries no reference to preserve; leave the text as-is.
      if (wrapper.image) return null
      // Re-render with the AUTHOR's display text rather than the ladder's
      // `pinLabel` — in this shape the author's text is `display`, and the
      // pinned form's whole purpose is to keep it. Verified the same way
      // every other spliced span is.
      //
      // The `null` branch is DEFENCE IN DEPTH, not a reachable path. It
      // needs `pinnedSpanReplacement` to refuse, and for a display this
      // detection accepts that means only a non-UUID target — which
      // already made the LADDER refuse upstream, so no pinned replacement
      // would exist to splice here. (`[` can't appear: the opener scan
      // takes the innermost bracket. `]`/newline can't: rejected above.)
      // Kept anyway, because the two calls verify DIFFERENT labels — the
      // ladder's invented one, this one's authored one — and a splice that
      // emits unverified text is wrong on its own terms. Degrades like an
      // embed: a working late-binding link, whose now-stale edge the caller
      // invalidates for the re-parse.
      //
      // `lossyLabel` is deliberately NOT reported here, unlike in
      // `preferredSpanReplacement`. That warning exists because the ladder
      // INVENTS a label and may sanitize it; here the label is text the
      // author already had in a label position, so the rendered display
      // does not change. Its `]`/newline half cannot fire either — the
      // wrapper detection already rejects both.
      const replacement = pinnedSpanReplacement(wrapper.display, pinned)
      if (replacement === null) return null
      return {start: wrapper.start, end: wrapper.end, text: replacement.text}
    }
  }
  // `![[alias]]` is the PAGE EMBED form, and markdown is a third grammar
  // sharing this text. Splicing the pinned form under a leading `!` yields
  // `![label](((uuid)))` — a markdown IMAGE, and `remark-blockrefs` only
  // visits `link`/`text` nodes, so it renders as a broken `<img>`. The
  // reference survives; the display doesn't, which is the half of the
  // span's meaning the pinned form exists to preserve. Callers splicing a
  // pinned replacement pass `skipEmbeds` and leave those spans as the
  // working late-binding embed they already are. (A wikilink→wikilink swap
  // is safe under `!` — still a page embed — so this is opt-in, not
  // automatic.)
  if (rewrite.skipEmbeds
    && mark.startIndex > 0 && content[mark.startIndex - 1] === '!') return null
  return {start: mark.startIndex, end: mark.endIndex, text: rewrite.text}
}

/** Replace every wikilink whose alias exactly matches `alias` with
 *  the literal `replacement` string. Uses `parseReferences` to find
 *  spans and avoids the
 *  `String.replace` regex-replacement-string pitfall where `$&`,
 *  `$1`, etc. in `replacement` would be interpreted as backreferences
 *  rather than literals. Returns the input unchanged when no span
 *  matches. */
export const rewriteWikilinks = (
  content: string,
  alias: string,
  replacement: string,
  opts?: {skipEmbeds?: boolean; pinnedTargetId?: string},
): string => {
  if (alias === '') return content  // parser never emits empty-alias marks
  const marks = parseReferences(content)
  if (marks.length === 0) return content
  const rewrite: WikilinkRewrite = {text: replacement, ...opts}
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    // Nested wikilinks (`[[outer [[inner]] tail]]`) produce overlapping
    // spans. Skip any whose start falls inside a span we've already
    // rewritten — replacing both would corrupt the outer's text.
    if (mark.startIndex < cursor) continue
    if (mark.alias !== alias) continue
    const splice = spliceFor(content, mark, rewrite)
    if (splice === null) continue
    // A wrapper splice starts BEFORE the mark; if a previous replacement
    // already consumed that text, widening here would corrupt it.
    if (splice.start < cursor) continue
    result += content.slice(cursor, splice.start)
    result += splice.text
    cursor = splice.end
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}

/** Apply SEVERAL alias rewrites in ONE pass over the original spans.
 *
 *  Not the same as calling `rewriteWikilinks` once per alias. Sequential
 *  calls each re-parse the previous call's OUTPUT, so a replacement can
 *  be consumed by a later rewrite: given `α → β` and `β → γ` (one synced
 *  commit can rename two blocks at once), a source holding `[[α]]` has
 *  it turned into `[[β]]` by the first pass and then into `[[γ]]` by the
 *  second — stealing α's link for γ, while the stored edge still maps
 *  α's entry to β's block. Parsing once and splicing from the ORIGINAL
 *  content makes each span the target of at most one rewrite.
 *
 *  `skipEmbeds` / `pinnedTargetId` are per-alias because they track
 *  whether THAT alias's replacement is the pinned form (see
 *  `rewriteWikilinks` and `linkFormWrapperAround`). */
export const rewriteWikilinksMulti = (
  content: string,
  replacements: ReadonlyMap<string, WikilinkRewrite>,
): string => {
  if (replacements.size === 0) return content
  const marks = parseReferences(content)
  if (marks.length === 0) return content
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    if (mark.startIndex < cursor) continue
    const replacement = replacements.get(mark.alias)
    if (replacement === undefined) continue
    const splice = spliceFor(content, mark, replacement)
    if (splice === null) continue
    // See `rewriteWikilinks`: a wrapper splice reaches back before the mark.
    if (splice.start < cursor) continue
    result += content.slice(cursor, splice.start)
    result += splice.text
    cursor = splice.end
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}

/** Replace block-ref marks targeting `blockId` with inline text — used
 *  when the target block is deleted so its references degrade gracefully
 *  to the text they displayed rather than dangling. Plain `((id))` and
 *  embed `!((id))` marks (which display the target's content) become
 *  `inlineContent`; aliased `[label](((id)))` marks (which display the
 *  label) keep their `label`. Marks targeting other ids are untouched.
 *  Mirrors `rewriteBlockRefs`'s parse-spans-and-slice approach so
 *  `inlineContent` is inserted literally (no `String.replace` `$&`
 *  pitfall) and overlapping/nested marks don't corrupt the slicing. */
export const inlineBlockRefs = (
  content: string,
  blockId: string,
  inlineContent: string,
): string => {
  const normalizedId = blockId.toLowerCase()
  const marks = parseBlockRefs(content)
  if (marks.length === 0) return content
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    if (mark.startIndex < cursor) continue
    if (mark.blockId !== normalizedId) continue
    result += content.slice(cursor, mark.startIndex)
    // Degrade to what the mark DISPLAYED: the label for labeled marks;
    // the target's content otherwise. An EMPTY-label aliased mark
    // renders like a plain ref (remark-blockrefs emits no display
    // children for it, so BlockRef falls back to target content) —
    // it takes the inlineContent path too.
    result += mark.label ? mark.label : inlineContent
    cursor = mark.endIndex
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}

/** Replace block-ref ids in `((id))`, `!((id))`, and `[label](((id)))`
 *  forms while preserving embed-ness and display labels. */
export const rewriteBlockRefs = (
  content: string,
  fromId: string,
  toId: string,
): string => {
  const normalizedFrom = fromId.toLowerCase()
  const marks = parseBlockRefs(content)
  if (marks.length === 0) return content
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    if (mark.startIndex < cursor) continue
    if (mark.blockId !== normalizedFrom) continue
    result += content.slice(cursor, mark.startIndex)
    if (mark.label !== undefined) {
      result += renderAliasedBlockref(mark.label, toId)
    } else {
      result += mark.embed ? `!((${toId}))` : `((${toId}))`
    }
    cursor = mark.endIndex
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}
