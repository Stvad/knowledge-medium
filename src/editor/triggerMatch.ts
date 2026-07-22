/** Shared trigger-char detection for editor autocompletes (`@` places,
 *  `#` type tags). One implementation of the backward walk + guards so
 *  the fiddly parts — especially the wikilink-ownership parsing — can
 *  only be fixed in one place.
 *
 *  Trigger shape: `<trigger><query>` and no `[`/`]` in the query (the
 *  wikilink autocomplete owns `[[…`). What may precede the trigger is
 *  trigger-specific: `@` never fires after a word character (so emails
 *  like `a@b` don't fire), while `#` may be glued straight onto the tail
 *  of a word (`title#todo` — so tagging a one-word block needs no
 *  throwaway space) and bows out only inside a URL path
 *  (`example.com/page#section` is an anchor, not a tag). The query may
 *  contain single spaces ("Blue Bottle Coffee",
 *  "Meeting Note") — a double space, other whitespace, or the
 *  length/word caps end it so prose after a bare `@word`/`#word`
 *  doesn't keep the dropdown alive. A query that starts with a space
 *  never matches (`see you @ 5pm`, and `# Title` markdown headings).
 *  Ownership rules: the trigger nearest the cursor wins over a viable
 *  sibling trigger, and spans owned by other autocompletes — unclosed
 *  `[[` wikilinks and `((` blockrefs — never fire a char trigger. */

export interface TriggerMatch {
  /** Position in the text where the trigger char itself sits. The
   *  inserted/deleted span starts here (so the trigger is consumed). */
  from: number
  /** The text typed after the trigger, possibly empty. */
  query: string
}

export interface CharTriggerOptions {
  /** Reject when the char immediately before the trigger is the
   *  trigger itself — `##foo` is markdown-heading territory, not a
   *  half-typed `#` tag. (The `@` place trigger doesn't set this:
   *  `@@name` has no competing syntax.) */
  rejectDoubledTrigger?: boolean
  /** Allow the trigger to fire when a word character sits immediately
   *  before it (`title#todo`), instead of treating that as email- /
   *  anchor-like and bowing out. The `#` type trigger sets this so a tag
   *  can be glued onto a word without a throwaway leading space; a `/`
   *  earlier in the same token still bows out (URL path). The `@` place
   *  trigger leaves it off — `user@host` must stay an email. */
  allowWordCharBefore?: boolean
}

/** All registered trigger chars. The walk breaks on a SIBLING trigger
 *  so the nearest trigger owns the input: in `meet @cafe #todo|` the
 *  `#` source matches `todo` while the `@` walk hits the `#` and
 *  yields — otherwise both sources fire into one dropdown, the place
 *  query swallows ` #todo` (a remote Places request per keystroke),
 *  and the type query swallows ` @home`. */
const TRIGGER_CHARS: ReadonlySet<string> = new Set(['@', '#'])

/** Queries routinely span words, so the caps below decide when a
 *  trigger earlier in the line stops owning what the user types: a
 *  double space or any non-space whitespace ends the query
 *  immediately, and a query longer than this many chars/words is
 *  prose, not a name. Without the caps, every sentence containing a
 *  bare `@word` would re-open the dropdown on each keystroke until end
 *  of line. */
const MAX_QUERY_LEN = 50
const MAX_QUERY_WORDS = 6

/** True when `beforePos` sits after an unclosed `[[` — wikilink spans
 *  belong to the wikilink autocomplete, so char triggers inside them
 *  must not fire. Mirrors backlinkAutocomplete's own matcher exactly
 *  (`/\[\[([^\]]*?)$/`): the span is a `[[` with no `]` between it and
 *  the position. Pair-counting `[[`/`]]` here is WRONG the same way the
 *  blockref comment below explains: a stray leading `]]` numerically
 *  cancels a later, genuinely-unclosed `[[` (found by
 *  triggerMatch.fuzz.test.ts — `']] [[ #tag'` fired both the wikilink
 *  and the `#` dropdown at once). */
const isInsideUnclosedWikilink = (text: string, beforePos: number): boolean =>
  /\[\[[^\]]*$/.test(text.slice(0, beforePos))

/** True when a word-glued `#` (`allowWordCharBefore`) actually sits at
 *  the tail of a URL path (`example.com/page#section`) rather than on a
 *  plain word (`title`) — signalled by a `/` earlier in the same
 *  whitespace-delimited token. Scheme URLs (`http://…/#a`) are also
 *  caught downstream by the editor's syntax-tree literal check; this
 *  keeps the raw matcher from firing on bare, schemeless URLs too. */
const tokenBeforeHasSlash = (text: string, triggerPos: number): boolean =>
  /\/[^\s]*$/.test(text.slice(0, triggerPos))

/** Whether a sibling trigger char at `sibPos` would itself fire — i.e.
 *  own the input — so the current walk (whose cursor is `pos`) must
 *  yield to it. Yielding to a sibling that CAN'T fire would leave a dead
 *  zone where no source opens, so this must mirror each trigger's OWN
 *  firing rules, not a rough approximation:
 *   - The sibling's query runs from `sibPos + 1` to `pos`. It can't fire
 *     if that query starts with a space (`@C# dev` — the `#` query would
 *     be ` dev`). But when the sibling sits right at the cursor
 *     (`sibPos + 1 === pos`) the query is EMPTY, which is a valid,
 *     firing query — so the space test must only look at a real query
 *     char (`sibPos + 1 < pos`), never at `text[pos]` (content past the
 *     cursor that belongs to no query).
 *   - `@` bows out after a word char (email-like).
 *   - `#` may glue onto a word but not a doubled `##`, and — like the
 *     real `#` matcher below — bows out inside a URL-path token
 *     (`@ a/b#c` must NOT yield to the `#`, which can't fire there). */
const siblingWouldFire = (text: string, sibPos: number, pos: number): boolean => {
  const afterPos = sibPos + 1
  if (afterPos < pos && text[afterPos] === ' ') return false
  const before = sibPos > 0 ? text[sibPos - 1] : ''
  if (text[sibPos] === '#') return before !== '#' && !tokenBeforeHasSlash(text, sibPos)
  return !/\w/.test(before)
}

/** Pure trigger-detection helper. Callers export thin per-char
 *  wrappers (`matchAtTrigger`, `matchHashTrigger`) for their
 *  CompletionSources and tests. */
export const matchCharTrigger = (
  text: string,
  pos: number,
  trigger: string,
  opts: CharTriggerOptions = {},
): TriggerMatch | null => {
  // Checked invariant, not just documentation: a new trigger char that
  // isn't in TRIGGER_CHARS would get silently ASYMMETRIC ownership
  // (its walk yields to the others, theirs plow through it). Fail loud
  // on the new wrapper's first test instead.
  if (!TRIGGER_CHARS.has(trigger)) {
    throw new Error(`matchCharTrigger: trigger '${trigger}' is not registered in TRIGGER_CHARS`)
  }
  // Walk backward from the cursor to find the most recent trigger
  // char. Single spaces are part of the query; wikilink brackets,
  // non-space whitespace, a double space, or an over-long scan
  // interrupt the trigger sequence.
  let i = pos
  while (i > 0) {
    const c = text[i - 1]
    if (c === trigger) break
    // A sibling trigger closer to the cursor owns this input — but
    // only a VIABLE one that could actually fire. A sibling that can't
    // (`C# dev` where the `#` query would start with a space, `a/b#c`
    // where the `#` sits in a URL path, `user@` where `@` bows out
    // after a word) is treated as query text; yielding to it would
    // leave a dead zone where NO source opens.
    if (TRIGGER_CHARS.has(c) && siblingWouldFire(text, i - 1, pos)) return null
    if (c === ' ') {
      if (i >= 2 && text[i - 2] === ' ') return null
    } else if (/\s/.test(c)) {
      return null
    }
    if (c === '[' || c === ']') return null
    if (pos - i >= MAX_QUERY_LEN) return null
    i -= 1
  }
  if (i === 0 || text[i - 1] !== trigger) return null

  const query = text.slice(i, pos)
  // `@ 5pm` / `# Title` is prose (or a heading), not a half-typed query.
  if (query.startsWith(' ')) return null
  if (query.split(' ').filter(w => w.length > 0).length > MAX_QUERY_WORDS) return null

  const triggerPos = i - 1
  // Word char immediately before the trigger. `@` treats it as
  // email-like (`a@b`, `user@host`) and bows out. `#` allows a tag
  // glued onto the tail of a word (`title#todo`) so tagging a one-word
  // block needs no throwaway space.
  if (triggerPos > 0 && /\w/.test(text[triggerPos - 1]) && !opts.allowWordCharBefore) return null
  // URL path (`example.com/page#section`, `foo/#bar`) is an anchor, not
  // a tag: for a word-glue trigger, a `/` anywhere in the token ending
  // at the trigger disqualifies it — whether the `/` sits right before
  // the trigger or earlier in the token. (Independent of the word-char
  // check above, which a leading `/` would otherwise skip past.)
  if (opts.allowWordCharBefore && tokenBeforeHasSlash(text, triggerPos)) return null
  if (opts.rejectDoubledTrigger && triggerPos > 0 && text[triggerPos - 1] === trigger) return null
  // Trigger directly preceded by `[` → inside a half-typed `[[@foo`; skip.
  if (triggerPos > 0 && text[triggerPos - 1] === '[') return null
  // Trigger lives inside an unclosed `[[...` earlier on the line →
  // the wikilink autocomplete owns the input.
  if (isInsideUnclosedWikilink(text, triggerPos)) return null
  // Blockref ownership mirrors blockrefAutocomplete's own matcher
  // exactly (`/\(\(([^)]*?)$/`): a `((` span ends at the first single
  // `)`. Pair-counting `((`/`))` here would poison the rest of the
  // line after prose like `f((x)` and miss a genuine `((` preceded by
  // a stray `))`.
  if (/\(\([^)]*$/.test(text.slice(0, triggerPos))) return null

  return {from: triggerPos, query}
}
