// @vitest-environment node
/**
 * The contract that replaces the pending-move register: identity travels
 * with the clipboard content, so a paste resolves against what the OS
 * actually holds rather than against a remembered "current cut".
 *
 * The tests worth having here are the ones that used to be BUGS in the
 * register design — each is a scenario that needed an explicit
 * invalidation call before, and now needs none.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  decodePayloadHtml,
  markCutCompleted,
  encodePayloadHtml,
  recallPayloadForText,
  rememberPayload,
  resetRememberedPayloads,
  resolveClipboardPayload,
  type ClipboardPayload,
} from './clipboardPayload.ts'

const CUT: ClipboardPayload = {blockIds: ['a', 'b'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-1'}
const MD = '- a\n- b'

beforeEach(() => { resetRememberedPayloads() })

describe('html flavor round trip', () => {
  it('carries the payload and the markdown', () => {
    const html = encodePayloadHtml(MD, CUT)
    expect(decodePayloadHtml(html, MD)).toEqual(CUT)
    expect(html).toContain('- a\n- b')
  })

  it('escapes markdown that would otherwise be markup', () => {
    const markup = '<script>alert(1)</script> & <b>'
    const html = encodePayloadHtml(markup, CUT)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    // The marker still parses with escaped content sitting after it.
    expect(decodePayloadHtml(html, markup)).toEqual(CUT)
  })

  it('survives markdown that itself contains the marker close sequence', () => {
    // The payload JSON is delimited by the FIRST `-->` after the opener,
    // so content further along can't truncate it.
    expect(decodePayloadHtml(encodePayloadHtml('a --> b', CUT), 'a --> b')).toEqual(CUT)
  })

  it('is null for html from any other app', () => {
    expect(decodePayloadHtml('<meta charset="utf-8"><p>hello</p>', MD)).toBeNull()
    expect(decodePayloadHtml('', MD)).toBeNull()
    expect(decodePayloadHtml(undefined, MD)).toBeNull()
  })

  it('is null when the marker describes DIFFERENT text than it arrived with', () => {
    // A rich-text app that round-trips our html can preserve the comment
    // while the visible content changes. Without the digest the stale
    // marker would move blocks the user never cut.
    const html = encodePayloadHtml(MD, CUT)
    expect(decodePayloadHtml(html, 'completely different text')).toBeNull()
    // ...and still resolves for the text it really shipped with.
    expect(decodePayloadHtml(html, MD)).toEqual(CUT)
  })

  it('is null — never a throw — for a malformed or unknown-version marker', () => {
    expect(decodePayloadHtml('<!--knowledge-medium:{not json-->x', MD)).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":999,"blockIds":[],"workspaceId":"w","intent":"cut"}-->', MD)).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":1,"blockIds":"nope","workspaceId":"w","intent":"cut"}-->', MD)).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":1,"blockIds":[1,2],"workspaceId":"w","intent":"cut"}-->', MD)).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":1,"blockIds":[],"workspaceId":"w","intent":"paste"}-->', MD)).toBeNull()
  })
})

describe('the text-only lookup table', () => {
  it('recalls a payload for the exact text it was stored under', () => {
    rememberPayload('- a\n- b', CUT)
    expect(recallPayloadForText('- a\n- b')).toEqual(CUT)
  })

  // Each of these was a REGISTER BUG that needed its own invalidation
  // call. Content addressing answers them with no bookkeeping at all.
  describe('scenarios that needed explicit invalidation before', () => {
    it('a later copy of different content simply misses', () => {
      rememberPayload('- a\n- b', CUT)
      expect(recallPayloadForText('something else entirely')).toBeNull()
    })

    it('two overlapping cuts each resolve to whatever text actually won the clipboard', () => {
      const first: ClipboardPayload = {blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-2'}
      const second: ClipboardPayload = {blockIds: ['b'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-3'}
      // Deliberately stored out of gesture order — the table has no notion
      // of which cut is "current", so order can't matter.
      rememberPayload('second cut', second)
      rememberPayload('first cut', first)

      expect(recallPayloadForText('second cut')).toEqual(second)
      expect(recallPayloadForText('first cut')).toEqual(first)
    })

    it('an entry for content the clipboard no longer holds is unreachable, not dangerous', () => {
      rememberPayload('- a\n- b', CUT)
      // The user copied something from another app. Nothing told the table.
      expect(recallPayloadForText('text from another app')).toBeNull()
    })
  })

  it('verifies the full text, so a hash collision cannot move the wrong blocks', () => {
    // The index is a 32-bit hash whose own doc says collisions are "rare
    // but not negligible"; absorbing one here would mean moving blocks the
    // user never cut, so equality is what actually decides.
    rememberPayload('- a\n- b', CUT)
    const forged = {blockIds: ['zzz'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-4'} as const
    rememberPayload('- a\n- b', forged) // same key, replaces
    expect(recallPayloadForText('- a\n- b')).toEqual(forged)
    expect(recallPayloadForText('- a\n- c')).toBeNull()
  })

  it('evicts oldest-first past its cap, and keeps the newest reachable', () => {
    for (let i = 0; i < 25; i++) {
      rememberPayload(`text ${i}`, {blockIds: [`b${i}`], workspaceId: 'ws-1', intent: 'cut', cutId: `c${i}`})
    }
    expect(recallPayloadForText('text 0')).toBeNull()
    expect(recallPayloadForText('text 24')).toEqual({
      blockIds: ['b24'], workspaceId: 'ws-1', intent: 'cut', cutId: 'c24',
    })
  })

  it('re-remembering the same text refreshes its eviction position', () => {
    rememberPayload('keep me', CUT)
    for (let i = 0; i < 19; i++) {
      rememberPayload(`filler ${i}`, {blockIds: [`f${i}`], workspaceId: 'ws-1', intent: 'cut', cutId: `f${i}`})
    }
    // 20 entries: 'keep me' is the oldest and the next write would evict it.
    rememberPayload('keep me', CUT)
    rememberPayload('one more', {blockIds: ['x'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-5'})

    expect(recallPayloadForText('keep me')).toEqual(CUT)
    expect(recallPayloadForText('filler 0')).toBeNull()
  })
})

describe('resolveClipboardPayload', () => {
  it('prefers the html flavor — the authoritative, cross-tab source', () => {
    const fromTable: ClipboardPayload = {blockIds: ['stale'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-6'}
    rememberPayload('- a\n- b', fromTable)

    expect(resolveClipboardPayload(MD, encodePayloadHtml(MD, CUT))).toEqual(CUT)
  })

  it('falls back to the table when there is no html — the bare-keypress paste paths', () => {
    rememberPayload('- a\n- b', CUT)
    expect(resolveClipboardPayload('- a\n- b', undefined)).toEqual(CUT)
  })

  it('treats another app\'s html as proof the clipboard is NOT ours', () => {
    // The table is only for callers with no html to go on. Consulting it
    // when html is present but foreign means rich text that happens to
    // match a cut's markdown moves those blocks instead of pasting what
    // was actually copied.
    rememberPayload('- a\n- b', CUT)
    expect(resolveClipboardPayload('- a\n- b', '<p>from somewhere else</p>')).toBeNull()
  })

  it('is null when neither source knows the content', () => {
    expect(resolveClipboardPayload('never seen', undefined)).toBeNull()
  })

  describe('a cut that already moved', () => {
    it('downgrades to a copy, so pasting twice inserts text instead of relocating again', () => {
      // The clipboard still carries the cut — nothing can rewrite it from
      // inside a paste handler. Without downgrading, the second paste
      // moves the same blocks from the first destination to the second and
      // the first paste looks undone. Text editors insert the text again;
      // so does this, by falling through to an ordinary paste.
      rememberPayload(MD, CUT)
      expect(resolveClipboardPayload(MD, undefined)).toEqual(CUT)

      markCutCompleted(CUT)

      expect(resolveClipboardPayload(MD, undefined)).toEqual({...CUT, intent: 'copy'})
    })

    it('downgrades through the RAW table read too, not only the composed resolver', () => {
      // The keyboard paste path reaches for the table. When the downgrade
      // lived only in `resolveClipboardPayload`, that surface kept
      // relocating a spent cut — the same bug, surviving on the other
      // surface. Every reader applies it now.
      rememberPayload(MD, CUT)
      markCutCompleted(CUT)

      expect(recallPayloadForText(MD)).toEqual({...CUT, intent: 'copy'})
    })

    it('downgrades on the html path too, which cannot be rewritten either', () => {
      const html = encodePayloadHtml(MD, CUT)
      markCutCompleted(CUT)

      expect(resolveClipboardPayload(MD, html)).toEqual({...CUT, intent: 'copy'})
    })

    it('re-cutting the same blocks arms a fresh cut', () => {
      markCutCompleted(CUT)
      expect(resolveClipboardPayload(MD, undefined)).toBeNull() // nothing remembered yet

      rememberPayload(MD, CUT)

      expect(resolveClipboardPayload(MD, undefined)).toEqual(CUT)
    })

    it('a FRESH cut of the same blocks is not spent by an earlier one', () => {
      // The cross-tab case: tab A completed a cut of these blocks, tab B
      // then cut them again. B's `rememberPayload` cannot reach A's
      // completion set, so keying completion by block ids would leave A
      // downgrading B's brand-new cut to a copy forever. The key is the
      // gesture, not the blocks.
      const earlier: ClipboardPayload = {
        blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut', cutId: 'gesture-1',
      }
      const fresh: ClipboardPayload = {
        blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut', cutId: 'gesture-2',
      }
      markCutCompleted(earlier)

      expect(decodePayloadHtml(encodePayloadHtml(MD, fresh), MD)).toEqual(fresh)
    })

    it('leaves an unrelated cut alone', () => {
      const other: ClipboardPayload = {blockIds: ['zzz'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-10'}
      rememberPayload('other text', other)
      markCutCompleted(CUT)

      expect(resolveClipboardPayload('other text', undefined)).toEqual(other)
    })
  })

  // Cutting a genuinely EMPTY block leaves empty text on the clipboard.
  // Under the register this was a standing hazard — the sentinel was the
  // empty string, and every "did the user actually copy anything?" guard
  // ate it, so the cut could never be completed. Here empty text is not a
  // special case at all, which is the point: it's just a key like any
  // other. Both surfaces are covered because the two differ in exactly
  // whether html is available.
  it('resolves an empty-block cut from either source', () => {
    const empty: ClipboardPayload = {blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-11'}
    rememberPayload('', empty)

    expect(resolveClipboardPayload('', undefined)).toEqual(empty)
    expect(resolveClipboardPayload('', encodePayloadHtml('', empty))).toEqual(empty)
  })
})
