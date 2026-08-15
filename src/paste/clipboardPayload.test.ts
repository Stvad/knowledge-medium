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

describe('the two readers', () => {
  // Which reader a surface uses is decided by what it can SEE, never by
  // inspecting the content. Events read html; keyboard pastes read the
  // table. A combined helper that branched on whether html was truthy made
  // an event with no html look like a keyboard paste — which is exactly
  // how foreign plain text ended up matching a remembered cut.
  it('an event with our marker decodes it', () => {
    expect(decodePayloadHtml(encodePayloadHtml(MD, CUT), MD)).toEqual(CUT)
  })

  it('an event with ANOTHER app\'s html is not a cut, even if the text matches one', () => {
    rememberPayload(MD, CUT)
    expect(decodePayloadHtml('<p>from somewhere else</p>', MD)).toBeNull()
  })

  it('an event with NO html is not a cut either — our writes always carry the marker', () => {
    rememberPayload(MD, CUT)
    expect(decodePayloadHtml(undefined, MD)).toBeNull()
    expect(decodePayloadHtml('', MD)).toBeNull()
  })

  it('a keyboard paste has only the table, and finds the cut there', () => {
    rememberPayload(MD, CUT)
    expect(recallPayloadForText(MD)).toEqual(CUT)
  })

  it('a keyboard paste of unknown text finds nothing', () => {
    expect(recallPayloadForText('never seen')).toBeNull()
  })

  // Cutting a genuinely EMPTY block leaves empty text on the clipboard,
  // and under the register that was a standing hazard: the sentinel was
  // the empty string, which every "did the user copy anything?" guard ate.
  // Here it is a key like any other.
  it('resolves an empty-block cut on both surfaces', () => {
    const empty: ClipboardPayload = {
      blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut', cutId: 'empty-1',
    }
    rememberPayload('', empty)

    expect(recallPayloadForText('')).toEqual(empty)
    expect(decodePayloadHtml(encodePayloadHtml('', empty), '')).toEqual(empty)
  })
})

describe('a cut that already moved', () => {
  it('downgrades to a copy, so pasting twice inserts text instead of relocating again', () => {
    // Nothing can rewrite the OS clipboard from inside a paste handler, so
    // the cut is still sitting there. Without the downgrade the second
    // paste moves the same blocks from the first destination to the
    // second, and the first paste looks undone.
    rememberPayload(MD, CUT)
    expect(recallPayloadForText(MD)).toEqual(CUT)

    markCutCompleted(CUT)

    expect(recallPayloadForText(MD)).toEqual({...CUT, intent: 'copy'})
  })

  it('downgrades on the html reader too, which cannot be rewritten either', () => {
    const html = encodePayloadHtml(MD, CUT)
    markCutCompleted(CUT)

    expect(decodePayloadHtml(html, MD)).toEqual({...CUT, intent: 'copy'})
  })

  it('re-cutting the same blocks arms a fresh cut', () => {
    markCutCompleted(CUT)
    rememberPayload(MD, CUT)

    expect(recallPayloadForText(MD)).toEqual(CUT)
  })

  it('a FRESH cut of the same blocks is not spent by an earlier one', () => {
    // The cross-tab case: tab A completed a cut of these blocks, tab B cut
    // them again. B's `rememberPayload` cannot reach A's completion set,
    // so keying completion by block ids would leave A downgrading B's
    // brand-new cut forever. The key is the gesture, not the blocks.
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
    const other: ClipboardPayload = {
      blockIds: ['zzz'], workspaceId: 'ws-1', intent: 'cut', cutId: 'other-1',
    }
    rememberPayload('other text', other)
    markCutCompleted(CUT)

    expect(recallPayloadForText('other text')).toEqual(other)
  })
})
