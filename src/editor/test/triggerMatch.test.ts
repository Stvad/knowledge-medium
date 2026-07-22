/** Char-generic matcher cases, exercised through `@` (no options) —
 *  both production wrappers (`matchAtTrigger`, `matchHashTrigger`) are
 *  thin parameterizations of this one implementation; their suites
 *  keep only wrapper-specific guards (stacked `##`, etc.). */
import { describe, expect, it } from 'vitest'
import { matchCharTrigger } from '../triggerMatch'

const at = (text: string, pos: number) => matchCharTrigger(text, pos, '@')

describe('matchCharTrigger', () => {
  it('matches at start of line', () => {
    expect(at('@dandelion', 10)).toEqual({from: 0, query: 'dandelion'})
  })

  it('matches after whitespace and after non-word punctuation', () => {
    expect(at('met at @blue', 12)).toEqual({from: 7, query: 'blue'})
    expect(at('(@blue', 6)).toEqual({from: 1, query: 'blue'})
  })

  it('matches with an empty query (right after the trigger)', () => {
    expect(at('met at @', 8)).toEqual({from: 7, query: ''})
  })

  it('matches multi-word queries across single spaces, up to a mid-word cursor', () => {
    expect(at('lunch @blue bottle', 11)).toEqual({from: 6, query: 'blue'})
    expect(at('lunch @blue bottle', 18)).toEqual({from: 6, query: 'blue bottle'})
    expect(at('@blue ', 6)).toEqual({from: 0, query: 'blue '})
  })

  it('does NOT match with a word char before the trigger by default (emails)', () => {
    expect(at('a@b', 3)).toBeNull()
    expect(at('user@example', 12)).toBeNull()
  })

  it('allowWordCharBefore lets the trigger glue onto a word (title#todo); off by default', () => {
    expect(matchCharTrigger('title#todo', 10, '#', {allowWordCharBefore: true}))
      .toEqual({from: 5, query: 'todo'})
    expect(matchCharTrigger('title#', 6, '#', {allowWordCharBefore: true}))
      .toEqual({from: 5, query: ''})
    // Same input, option off → still bows out.
    expect(matchCharTrigger('title#todo', 10, '#')).toBeNull()
  })

  it('allowWordCharBefore still bows out inside a URL path (a slash in the trigger token)', () => {
    expect(matchCharTrigger('example.com/page#section', 24, '#', {allowWordCharBefore: true}))
      .toBeNull()
    // A slash in an EARLIER token doesn't count — only the token the
    // trigger sits at the tail of.
    expect(matchCharTrigger('a/b word#tag', 12, '#', {allowWordCharBefore: true}))
      .toEqual({from: 8, query: 'tag'})
  })

  it('a word-glued # wins over an earlier @ — the @ walk yields, no double-fire', () => {
    // Now that `#todo` can glue onto `word`, the `#` source owns it, so
    // the `@` walk must yield; otherwise `@` swallows `cafe word#todo`
    // into a place query while `#` also fires into the same dropdown.
    const hashOpts = {rejectDoubledTrigger: true, allowWordCharBefore: true}
    expect(matchCharTrigger('meet @cafe word#todo', 20, '#', hashOpts))
      .toEqual({from: 15, query: 'todo'})
    expect(at('meet @cafe word#todo', 20)).toBeNull()
  })

  it('the @ walk does NOT yield to a # sibling that sits in a URL path (no dead zone)', () => {
    // The `#` in `a/b#c` can't fire (URL-path guard), so `@` must NOT
    // yield to it — otherwise neither source opens and the `@`
    // place-autocomplete silently dies whenever a slash-token with a `#`
    // appears later on the line.
    const hashOpts = {rejectDoubledTrigger: true, allowWordCharBefore: true}
    expect(matchCharTrigger('@a/b#c', 6, '#', hashOpts)).toBeNull()
    expect(at('@a/b#c', 6)).toEqual({from: 0, query: 'a/b#c'})
  })

  it('sibling viability is decided by the query end (cursor), not the char past the cursor', () => {
    // The `#` sits right at the cursor → its query is empty → it owns
    // the position, so `@` yields the SAME way regardless of what
    // (unrelated) text follows the cursor. Before the fix, `@C#| dev`
    // fired a garbage place query for "C#" while `@C#|zzz` dead-zoned.
    expect(at('@C# dev', 3)).toBeNull()
    expect(at('@C#zzz', 3)).toBeNull()
    expect(at('@C#', 3)).toBeNull()
    // …and once a real query char follows the # (query no longer empty),
    // the space-after-# rule applies at the query start as before.
    expect(at('@C# dev', 7)).toEqual({from: 0, query: 'C# dev'})
  })

  it('the URL-path guard fires even when the slash sits immediately before the # (/#)', () => {
    const hashOpts = {rejectDoubledTrigger: true, allowWordCharBefore: true}
    expect(matchCharTrigger('foo/#bar', 8, '#', hashOpts)).toBeNull()
    expect(matchCharTrigger('see docs/#install', 17, '#', hashOpts)).toBeNull()
  })

  it('does NOT match inside [[wikilink]] brackets', () => {
    expect(at('[[@foo', 6)).toBeNull()
    expect(at('[[foo @bar', 10)).toBeNull()
  })

  it('does NOT match when there is no trigger in the current token', () => {
    expect(at('dandelion', 9)).toBeNull()
  })

  it('does NOT match when the query starts with a space', () => {
    expect(at('see you @ 5pm', 13)).toBeNull()
  })

  it('does NOT match across a double space or tabs', () => {
    expect(at('@home  later that day', 21)).toBeNull()
    expect(at('@foo\tbar', 8)).toBeNull()
  })

  it('does NOT match once the query exceeds the word cap', () => {
    expect(at('@one two three four five six', 28))
      .toEqual({from: 0, query: 'one two three four five six'})
    expect(at('@one two three four five six seven', 34)).toBeNull()
  })

  it('does NOT match once the query exceeds the length cap', () => {
    const long = `@${'a'.repeat(60)}`
    expect(at(long, long.length)).toBeNull()
  })

  it('rejectDoubledTrigger rejects a doubled trigger char; off by default', () => {
    expect(matchCharTrigger('##task', 6, '#', {rejectDoubledTrigger: true})).toBeNull()
    expect(matchCharTrigger('@@name', 6, '@')).toEqual({from: 1, query: 'name'})
  })

  it('the nearest trigger owns the input — a viable sibling trigger breaks the walk', () => {
    // `#` matches its own query; the earlier `@` yields instead of
    // swallowing ` #todo` into a place query (which would fire a
    // remote Places request per tag keystroke).
    expect(matchCharTrigger('meet @cafe #todo', 16, '#')).toEqual({from: 11, query: 'todo'})
    expect(at('meet @cafe #todo', 16)).toBeNull()
    expect(at('meet #proj @home', 16)).toEqual({from: 11, query: 'home'})
    expect(matchCharTrigger('meet #proj @home', 16, '#')).toBeNull()
  })

  it('a NON-viable sibling (word char before it) is query text, not a dead zone', () => {
    // `C#` can never fire the # trigger — if the @ walk yielded to it,
    // NO source would open. Same for `@` inside an email-like token.
    expect(at('@C# dev', 7)).toEqual({from: 0, query: 'C# dev'})
    expect(matchCharTrigger('#email@work', 11, '#')).toEqual({from: 0, query: 'email@work'})
  })

  it('does NOT match inside an unclosed ((blockref span — ownership ends at the first single paren', () => {
    expect(matchCharTrigger('((see #to', 9, '#')).toBeNull()
    expect(at('((see @home', 11)).toBeNull()
    // A single paren is prose, not a blockref.
    expect(matchCharTrigger('(#task', 6, '#')).toEqual({from: 1, query: 'task'})
    // `f((x)` is CLOSED for the blockref matcher (first `)` ends it) —
    // a later trigger on the line must still fire…
    expect(matchCharTrigger('f((x) so #ta', 12, '#')).toEqual({from: 9, query: 'ta'})
    // …and a stray `))` earlier must not cancel a genuine `((`.
    expect(matchCharTrigger('x)) ((y #t', 10, '#')).toBeNull()
  })

  it('throws on a trigger char missing from TRIGGER_CHARS (checked invariant)', () => {
    expect(() => matchCharTrigger('!foo', 4, '!')).toThrow(/TRIGGER_CHARS/)
  })
})
