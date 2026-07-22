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
const tokenBeforeHasSlash = (text: string, triggerPos: number): boolean => {
  let start = triggerPos
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  return text.slice(start, triggerPos).includes('/')
}

/** Whether a sibling trigger char at `sibPos` (with `afterPos` the index
 *  just after it) would itself fire — i.e. own the input — so the
 *  current walk must yield to it. Mirrors each trigger's own prefix
 *  rules (`@` bows out after a word char; `#` allows the word-glue but
 *  not a doubled `##`) plus the shared "a query can't start with a
 *  space" rule. Yielding to a sibling that CAN'T fire would leave a dead
 *  zone where no source opens (see the `@C# dev` case in
 *  triggerMatch.test.ts, where the `#` query would start with a space). */
const siblingWouldFire = (text: string, sibPos: number, afterPos: number): boolean => {
  if (text[afterPos] === ' ') return false
  const before = sibPos > 0 ? text[sibPos - 1] : ''
  if (text[sibPos] === '#') return before !== '#'
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
    // (`C# dev` where the `#` query would start with a space, `user@`
    // where `@` bows out after a word) is treated as query text;
    // yielding to it would leave a dead zone where NO source opens.
    if (TRIGGER_CHARS.has(c) && siblingWouldFire(text, i - 1, i)) return null
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
  // block needs no throwaway space — except inside a URL path
  // (`example.com/page#section` is an anchor), spotted by a `/` earlier
  // in the same token.
  if (triggerPos > 0 && /\w/.test(text[triggerPos - 1])) {
    if (!opts.allowWordCharBefore) return null
    if (tokenBeforeHasSlash(text, triggerPos)) return null
  }
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
