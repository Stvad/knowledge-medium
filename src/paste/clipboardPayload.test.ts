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
  encodePayloadHtml,
  recallPayloadForText,
  rememberPayload,
  resetRememberedPayloads,
  resolveClipboardPayload,
  type ClipboardPayload,
} from './clipboardPayload.ts'

const CUT: ClipboardPayload = {blockIds: ['a', 'b'], workspaceId: 'ws-1', intent: 'cut'}

beforeEach(() => { resetRememberedPayloads() })

describe('html flavor round trip', () => {
  it('carries the payload and the markdown', () => {
    const html = encodePayloadHtml('- a\n- b', CUT)
    expect(decodePayloadHtml(html)).toEqual(CUT)
    expect(html).toContain('- a\n- b')
  })

  it('escapes markdown that would otherwise be markup', () => {
    const html = encodePayloadHtml('<script>alert(1)</script> & <b>', CUT)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    // The marker still parses with escaped content sitting after it.
    expect(decodePayloadHtml(html)).toEqual(CUT)
  })

  it('survives markdown that itself contains the marker close sequence', () => {
    // The payload JSON is delimited by the FIRST `-->` after the opener,
    // so content further along can't truncate it.
    const html = encodePayloadHtml('a --> b', CUT)
    expect(decodePayloadHtml(html)).toEqual(CUT)
  })

  it('is null for html from any other app', () => {
    expect(decodePayloadHtml('<meta charset="utf-8"><p>hello</p>')).toBeNull()
    expect(decodePayloadHtml('')).toBeNull()
    expect(decodePayloadHtml(undefined)).toBeNull()
  })

  it('is null — never a throw — for a malformed or unknown-version marker', () => {
    expect(decodePayloadHtml('<!--knowledge-medium:{not json-->x')).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":999,"blockIds":[],"workspaceId":"w","intent":"cut"}-->')).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":1,"blockIds":"nope","workspaceId":"w","intent":"cut"}-->')).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":1,"blockIds":[1,2],"workspaceId":"w","intent":"cut"}-->')).toBeNull()
    expect(decodePayloadHtml('<!--knowledge-medium:{"v":1,"blockIds":[],"workspaceId":"w","intent":"paste"}-->')).toBeNull()
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
      const first: ClipboardPayload = {blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut'}
      const second: ClipboardPayload = {blockIds: ['b'], workspaceId: 'ws-1', intent: 'cut'}
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
    const forged = {blockIds: ['zzz'], workspaceId: 'ws-1', intent: 'cut'} as const
    rememberPayload('- a\n- b', forged) // same key, replaces
    expect(recallPayloadForText('- a\n- b')).toEqual(forged)
    expect(recallPayloadForText('- a\n- c')).toBeNull()
  })

  it('evicts oldest-first past its cap, and keeps the newest reachable', () => {
    for (let i = 0; i < 25; i++) {
      rememberPayload(`text ${i}`, {blockIds: [`b${i}`], workspaceId: 'ws-1', intent: 'cut'})
    }
    expect(recallPayloadForText('text 0')).toBeNull()
    expect(recallPayloadForText('text 24')).toEqual({
      blockIds: ['b24'], workspaceId: 'ws-1', intent: 'cut',
    })
  })

  it('re-remembering the same text refreshes its eviction position', () => {
    rememberPayload('keep me', CUT)
    for (let i = 0; i < 19; i++) {
      rememberPayload(`filler ${i}`, {blockIds: [`f${i}`], workspaceId: 'ws-1', intent: 'cut'})
    }
    // 20 entries: 'keep me' is the oldest and the next write would evict it.
    rememberPayload('keep me', CUT)
    rememberPayload('one more', {blockIds: ['x'], workspaceId: 'ws-1', intent: 'cut'})

    expect(recallPayloadForText('keep me')).toEqual(CUT)
    expect(recallPayloadForText('filler 0')).toBeNull()
  })
})

describe('resolveClipboardPayload', () => {
  it('prefers the html flavor — the authoritative, cross-tab source', () => {
    const fromTable: ClipboardPayload = {blockIds: ['stale'], workspaceId: 'ws-1', intent: 'cut'}
    rememberPayload('- a\n- b', fromTable)

    expect(resolveClipboardPayload('- a\n- b', encodePayloadHtml('- a\n- b', CUT))).toEqual(CUT)
  })

  it('falls back to the table when there is no html — the bare-keypress paste paths', () => {
    rememberPayload('- a\n- b', CUT)
    expect(resolveClipboardPayload('- a\n- b', undefined)).toEqual(CUT)
  })

  it('falls back to the table when the html is another app\'s', () => {
    rememberPayload('- a\n- b', CUT)
    expect(resolveClipboardPayload('- a\n- b', '<p>from somewhere else</p>')).toEqual(CUT)
  })

  it('is null when neither source knows the content', () => {
    expect(resolveClipboardPayload('never seen', undefined)).toBeNull()
  })

  // Cutting a genuinely EMPTY block leaves empty text on the clipboard.
  // Under the register this was a standing hazard — the sentinel was the
  // empty string, and every "did the user actually copy anything?" guard
  // ate it, so the cut could never be completed. Here empty text is not a
  // special case at all, which is the point: it's just a key like any
  // other. Both surfaces are covered because the two differ in exactly
  // whether html is available.
  it('resolves an empty-block cut from either source', () => {
    const empty: ClipboardPayload = {blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut'}
    rememberPayload('', empty)

    expect(resolveClipboardPayload('', undefined)).toEqual(empty)
    expect(resolveClipboardPayload('', encodePayloadHtml('', empty))).toEqual(empty)
  })
})
