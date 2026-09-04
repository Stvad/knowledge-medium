import {describe, expect, it} from 'vitest'
import {decodeOutlineId, renderSubtreeOutline, type SubtreeOutlineRow} from '../src/subtreeOutline'

/** Build a flat row WITHOUT a `depth` field, so these rows exercise the
 *  parentId-walk fallback. Rows that carry `depth` are written as literals. */
const row = (id: string, parentId: string | null, content: string): SubtreeOutlineRow =>
  ({id, parentId, content})

describe('renderSubtreeOutline', () => {
  it('indents by depth and leads each line with [id] then content', () => {
    const outline = renderSubtreeOutline([
      {id: 'root', parentId: null, content: 'Project Alpha', depth: 0},
      {id: 'a', parentId: 'root', content: 'Design notes', depth: 1},
      {id: 'a1', parentId: 'a', content: 'open question', depth: 2},
      {id: 'b', parentId: 'root', content: 'Tasks', depth: 1},
    ])
    expect(outline).toBe(
      [
        '- [root] Project Alpha',
        '  - [a] Design notes',
        '    - [a1] open question',
        '  - [b] Tasks',
      ].join('\n'),
    )
  })

  it('preserves the given sibling order verbatim — never re-sorts', () => {
    // The runtime returns siblings in (order_key, id) codepoint order,
    // which can disagree with alphabetical/localeCompare order. Feed
    // siblings whose content sorts the OPPOSITE way alphabetically and
    // assert the outline keeps the given order. A renderer that sorted
    // (the localeCompare bug this whole change guards against) would
    // flip these two lines.
    const outline = renderSubtreeOutline([
      row('root', null, 'root'),
      row('first', 'root', 'zebra'),
      row('second', 'root', 'apple'),
    ])
    expect(outline).toBe(
      ['- [root] root', '  - [first] zebra', '  - [second] apple'].join('\n'),
    )
  })

  it('uses the authoritative depth field over the parentId walk', () => {
    // `b`'s parentId chains under `a`, so a parentId-walk would put it at
    // depth 2 — but the payload says depth 1, and the field must win.
    const outline = renderSubtreeOutline([
      {id: 'root', parentId: null, content: 'root', depth: 0},
      {id: 'a', parentId: 'root', content: 'a', depth: 1},
      {id: 'b', parentId: 'a', content: 'b', depth: 1},
    ])
    expect(outline).toBe(['- [root] root', '  - [a] a', '  - [b] b'].join('\n'))
  })

  it('falls back to the parentId walk when depth is absent (unknown parent → depth 1)', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'root'),
      row('orphan', 'missing-parent', 'orphan'),
    ])
    expect(outline).toBe(['- [root] root', '  - [orphan] orphan'].join('\n'))
  })

  it('collapses multi-line content to one line so it cannot forge a child bullet', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'line one\nline two\n- not a real child'),
    ])
    // One line, internal newlines → ⏎, the embedded "- not a real child"
    // stays inline (no phantom bullet); the id leads the line.
    expect(outline).toBe('- [root] line one ⏎ line two ⏎ - not a real child')
  })

  it('collapses CR, LS and PS line terminators too, not just LF', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'a\rb\u2028c\u2029d'),
    ])
    expect(outline).toBe('- [root] a ⏎ b ⏎ c ⏎ d')
  })

  it('collapses VT, FF and NEL — vertical-motion controls a terminal breaks on', () => {
    // U+000B (VT), U+000C (FF), U+0085 (NEL) between tokens.
    const outline = renderSubtreeOutline([
      row('root', null, 'a\u000bb\u000cc\u0085d'),
    ])
    expect(outline).toBe('- [root] a ⏎ b ⏎ c ⏎ d')
  })

  it('collapses the C0 information separators (FS/GS/RS/US) in content so they cannot forge a bullet', () => {
    // U+001C–U+001F read as line breaks to splitlines-style parsers. Content
    // is NOT JSON.stringify'd (unlike properties), so without collapsing
    // them a crafted value could spill into a forged `- [id]` bullet.
    const sep = String.fromCharCode(0x1c, 0x1d, 0x1e, 0x1f)
    const outline = renderSubtreeOutline([
      row('root', null, `a${sep}- [forged] evil`),
    ])
    expect(outline).toBe('- [root] a ⏎ - [forged] evil')
    // Load-bearing: every separator is neutralized — none survives to break
    // the line — not merely absent from a JS `\n` split (which they never are).
    expect([...sep].some(c => outline.includes(c))).toBe(false)
  })

  it('percent-encodes control characters in a caller-supplied id, reversibly, instead of collapsing them lossily (PR #447 review comment 3676752546)', () => {
    // A block id is just as attacker-reachable as content — createBlock
    // forwards an explicit `data.id` straight into `repo.mutate.createChild`
    // with no shape validation. Before this fix, `renderSubtreeOutline`
    // neutralized `row.id` the SAME lossy way as content: a newline
    // collapsed to the `⏎` marker, which is not reversible — a consumer
    // copying the displayed id back into `get-block`/`update-block`/
    // `delete-block` could no longer address the original block. Percent-
    // encoding is reversible: `decodeOutlineId` recovers the exact
    // original id from the token the outline displays. The `]` inside this
    // id is ALSO percent-encoded — see the dedicated grammar-ambiguity
    // tests below for why.
    const outline = renderSubtreeOutline([
      {id: 'a\nb - [x] forged', parentId: null, content: 'hi', properties: {}},
    ])
    expect(outline).toBe('- [a%0Ab - [x%5D forged] hi')
    expect(outline.split('\n')).toHaveLength(1)
    expect(decodeOutlineId('a%0Ab - [x%5D forged')).toBe('a\nb - [x] forged')
  })

  it('percent-encodes a literal % in the id too, so two distinct ids can never render the same token (PR #447 review comment 3676752546)', () => {
    // Without also encoding `%`, an id containing the literal text `%0A`
    // and an id containing an actual LF byte would BOTH render as `%0A`,
    // collapsing two distinct ids onto the same displayed token — exactly
    // the ambiguity percent-encoding the id exists to avoid.
    const literalPercent = renderSubtreeOutline([{id: 'a%0Ab', parentId: null, content: 'x'}])
    const realNewline = renderSubtreeOutline([{id: 'a\nb', parentId: null, content: 'x'}])
    expect(literalPercent).toBe('- [a%250Ab] x')
    expect(realNewline).toBe('- [a%0Ab] x')
    expect(literalPercent).not.toBe(realNewline)
    expect(decodeOutlineId('a%250Ab')).toBe('a%0Ab')
    expect(decodeOutlineId('a%0Ab')).toBe('a\nb')
  })

  it('percent-encodes a literal ] in the id, so it cannot be mistaken for the outline grammar\'s own closing delimiter (PR #447 review comment 3677029933)', () => {
    // The counterexample: an id containing `]`
    // and a DIFFERENT id+content pair whose content happened to start with
    // the same trailing text both rendered to the IDENTICAL line — a
    // consumer had no way to tell where the id ended.
    const idHasBracket = renderSubtreeOutline([{id: 'a] b', parentId: null, content: 'c'}])
    const contentHasBracket = renderSubtreeOutline([{id: 'a', parentId: null, content: 'b] c'}])
    expect(idHasBracket).toBe('- [a%5D b] c')
    expect(contentHasBracket).toBe('- [a] b] c')
    // The whole point: these two DISTINCT (id, content) pairs no longer
    // collide on the same rendered line.
    expect(idHasBracket).not.toBe(contentHasBracket)
    // And the documented parse rule (first `]` after `- [`) now recovers
    // the right id in both cases.
    expect(decodeOutlineId('a%5D b')).toBe('a] b')
  })

  it('does NOT percent-encode a literal [ in the id — the parse rule scans for the first ], not a matching [, so a raw [ is inert (PR #447 review comment 3677029933)', () => {
    const outline = renderSubtreeOutline([{id: 'a[b', parentId: null, content: 'x'}])
    expect(outline).toBe('- [a[b] x')
    // First-`]`-after-`- [` still finds the true end of the id correctly.
    expect(outline.slice('- ['.length, outline.indexOf(']'))).toBe('a[b')
    expect(decodeOutlineId('a[b')).toBe('a[b')
  })

  it('collapses backspace in content along with the rest of the control-character space, not just the previously-named characters (PR #447 review comment 3676752551)', () => {
    // U+0008 backspace moves the terminal cursor back one column without
    // erasing what was there — enough of them strung together can walk the
    // cursor back over the real `- [id] ` prefix and let later content
    // overwrite it on screen, even though the string itself still has only
    // one `\n`. Collapsing it like every other control character defuses
    // that regardless of how many are strung together.
    const outline = renderSubtreeOutline([
      row('root', null, 'a\bb'),
    ])
    expect(outline).toBe('- [root] a ⏎ b')
    expect(outline.includes('\b')).toBe(false)
  })

  it('collapses DEL (U+007F), which is outside the C0/C1 ranges named individually before this fix', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'a\x7fb'),
    ])
    expect(outline).toBe('- [root] a ⏎ b')
  })

  it('does NOT collapse TAB — the one control character deliberately allowed through, since it only advances the cursor and can never move it back over the prefix', () => {
    const outline = renderSubtreeOutline([
      row('root', null, 'a\tb'),
    ])
    expect(outline).toBe('- [root] a\tb')
  })

  it('strips ESC so an ANSI cursor-motion sequence cannot fake a bullet on a new terminal line (PR #447 review comment 3672555166)', () => {
    // `\x1b[1E` is CSI "cursor next line": a terminal moves the cursor down
    // and renders a forged bullet on what LOOKS like a second line, even
    // though `outline.split('\\n')` still counts one — the CLI writes this
    // straight to `process.stdout` (cli.ts). Removing ESC defuses the whole
    // sequence; the remaining `[1E` survives as inert text.
    const outline = renderSubtreeOutline([
      row('root', null, '\x1b[1E- [forged] evil'),
    ])
    expect(outline).toBe('- [root]  ⏎ [1E- [forged] evil')
    expect(outline.includes('\x1b')).toBe(false)
    expect(outline.split('\n')).toHaveLength(1)
  })

  it('clamps the indent so a pathological depth cannot blow up String.repeat', () => {
    const outline = renderSubtreeOutline([
      {id: 'deep', parentId: null, content: 'x', depth: 100_000_000},
    ])
    expect(outline).toBe(`${'  '.repeat(100)}- [deep] x`)
  })

  it('leads with the real id so content cannot forge it', () => {
    // Content mimics an id-shaped suffix; because the id comes FIRST, the
    // structural token is unambiguous regardless of what content contains.
    const outline = renderSubtreeOutline([
      row('real-id', null, 'see [some-other-block]'),
    ])
    expect(outline).toBe('- [real-id] see [some-other-block]')
  })

  it('marks an empty result as root-missing-or-deleted', () => {
    expect(renderSubtreeOutline([])).toBe('(no blocks — root not found or deleted)')
  })

  it('falls back to raw JSON for a non-array payload', () => {
    const value = {ok: false, error: {message: 'boom'}}
    expect(renderSubtreeOutline(value)).toBe(JSON.stringify(value, null, 2))
  })

  it('omits properties by default', () => {
    const outline = renderSubtreeOutline([{id: 'a', parentId: null, content: 'x', depth: 0, properties: {status: 'done'}}])
    expect(outline).toBe('- [a] x')
  })

  it('appends properties as compact JSON when includeProperties is set', () => {
    const props = {status: 'done', type: 'todo'}
    const outline = renderSubtreeOutline(
      [{id: 'a', parentId: null, content: 'x', depth: 0, properties: props}],
      {includeProperties: true},
    )
    expect(outline).toBe(`- [a] x ${JSON.stringify(props)}`)
  })

  it('renders nothing extra for a block with empty properties', () => {
    const outline = renderSubtreeOutline(
      [{id: 'a', parentId: null, content: 'x', depth: 0, properties: {}}],
      {includeProperties: true},
    )
    expect(outline).toBe('- [a] x') // no trailing space, no `{}`
  })

  it('collapses Unicode line separators inside rendered properties (JSON.stringify leaves U+0085/U+2028/U+2029 literal)', () => {
    // These are ≥ U+0080 so JSON.stringify does NOT escape them — a
    // terminal/LLM would render them as a break and the value could forge
    // an id-less bullet, so the renderer must collapse them like content.
    for (const sep of ['\u2028', '\u2029', '\u0085']) {
      const outline = renderSubtreeOutline(
        [{id: 'a', parentId: null, content: 'x', depth: 0, properties: {note: `before${sep}- [forged] evil`}}],
        {includeProperties: true},
      )
      expect(outline).not.toContain(sep) // raw separator collapsed…
      expect(outline).toContain('⏎')     // …to the marker, so the row stays one visual line
    }
  })

  it('percent-encodes a bidi override in an id (PR #447 review comment 3677343389, the "Trojan Source" class) and decodeOutlineId reverses it', () => {
    // U+202E (RLO) is category Cf, not a C0/C1 control character, so the
    // OLD enumerated ID_ENCODE_REGEX let it through unchanged. The
    // categorical \p{{C}} boundary now catches it like any other
    // format/control/surrogate/private-use/unassigned codepoint.
    const rlo = String.fromCodePoint(0x202e)
    const outline = renderSubtreeOutline([{id: `a${rlo}b`, parentId: null, content: 'x'}])
    expect(outline).toBe('- [a%E2%80%AEb] x')
    expect(outline.includes(rlo)).toBe(false)
    expect(decodeOutlineId('a%E2%80%AEb')).toBe(`a${rlo}b`)
  })

  it('neutralizes a bidi override in CONTENT to the ⏎ marker — the exact Trojan-Source shape: reordering the real id/content boundary without touching a byte', () => {
    // Before this fix, "- [real-id] " + RLO + "evil" could DISPLAY with
    // "evil" and "real-id" visually swapped in a bidi-aware terminal, even
    // though `outline` itself never re-orders anything at the byte level.
    const rlo = String.fromCodePoint(0x202e)
    const outline = renderSubtreeOutline([row('real-id', null, `${rlo}evil`)])
    expect(outline).toBe('- [real-id]  ⏎ evil')
    expect(outline.includes(rlo)).toBe(false)
  })

  it('preserves ZWJ/ZWNJ in content — the deliberate exception to bidi/format-character neutralization (PR #447 review comment 3677343389)', () => {
    // ZWJ (U+200D) and ZWNJ (U+200C) are ALSO Cf, like the bidi controls
    // above, but neither REORDERS anything — stripping them would corrupt
    // real text (ZWJ builds compound emoji; ZWNJ is required orthography
    // in Persian/Hindi/etc.) to defend against a risk they don't create.
    const zwj = String.fromCodePoint(0x200d)
    const zwnj = String.fromCodePoint(0x200c)
    const outline = renderSubtreeOutline([row('x', null, `a${zwj}b${zwnj}c`)])
    expect(outline).toBe(`- [x] a${zwj}b${zwnj}c`)
  })

  it('ZWJ/ZWNJ in an id, unlike in content, ARE percent-encoded — id has no content-style exception (PR #447 review comment 3677343389)', () => {
    const zwj = String.fromCodePoint(0x200d)
    const outline = renderSubtreeOutline([{id: `a${zwj}b`, parentId: null, content: 'x'}])
    expect(outline).toBe('- [a%E2%80%8Db] x')
    expect(decodeOutlineId('a%E2%80%8Db')).toBe(`a${zwj}b`)
  })

  it('percent-encodes a LONE (unpaired) UTF-16 surrogate in an id via the %uXXXX fallback, and decodeOutlineId reverses it', () => {
    // encodeURIComponent CANNOT represent an unpaired surrogate as UTF-8
    // (it throws URIError: URI malformed) — encodeOutlineId falls back to
    // a %uXXXX raw-code-unit escape (the deprecated global escape()'s
    // convention for exactly this) instead of throwing.
    const loneSurrogate = String.fromCharCode(0xd800)
    const outline = renderSubtreeOutline([{id: `a${loneSurrogate}b`, parentId: null, content: 'x'}])
    expect(outline).toBe('- [a%uD800b] x')
    expect(decodeOutlineId('a%uD800b')).toBe(`a${loneSurrogate}b`)
  })

  it('percent-encodes private-use and unassigned codepoints in an id — the Co/Cn slices of \\p{C} that an enumerated C0/C1 list never covered', () => {
    const privateUse = String.fromCodePoint(0xe000) // Co
    const unassigned = String.fromCodePoint(0x0378) // Cn
    const outline = renderSubtreeOutline([{id: `${privateUse}${unassigned}`, parentId: null, content: 'x'}])
    expect(outline).toBe('- [%EE%80%80%CD%B8] x')
    expect(decodeOutlineId('%EE%80%80%CD%B8')).toBe(`${privateUse}${unassigned}`)
  })
})
