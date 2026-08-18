// @vitest-environment node
/**
 * The shared opening of both paste-EVENT handlers. Each case here is a way
 * the two could drift apart, and each failure is silent — a dropped image
 * paste or an uncompletable cut looks exactly like "the user pasted
 * nothing".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClipboardEvent } from 'react'
import {
  encodePayloadHtml,
  rememberPayload,
  resetRememberedPayloads,
  type ClipboardPayload,
} from './clipboardPayload.ts'
import { readPasteEventContent } from './pasteEventContent.ts'

const CUT: ClipboardPayload = {blockIds: ['a'], workspaceId: 'ws-1', intent: 'cut', cutId: 'cut-15'}

/** A ClipboardEvent stub carrying only what the reader touches. */
const pasteEvent = (
  {text = '', html, files = []}: {text?: string; html?: string; files?: File[]},
): ClipboardEvent<HTMLElement> => ({
  clipboardData: {
    getData: (type: string) => (type === 'text/html' ? html ?? '' : text),
    files,
  },
} as unknown as ClipboardEvent<HTMLElement>)

const anImage = () => new File([new Uint8Array([1, 2])], 'x.png', {type: 'image/png'})

beforeEach(() => { resetRememberedPayloads() })

describe('readPasteEventContent', () => {
  it('reads both flavors and resolves the payload from them', () => {
    const content = readPasteEventContent(pasteEvent({
      text: 'hello', html: encodePayloadHtml('hello', CUT),
    }))

    expect(content.text).toBe('hello')
    expect(content.payload).toEqual(CUT)
    expect(content.hasAnything).toBe(true)
  })

  it('reports nothing to do for a genuinely empty paste', () => {
    expect(readPasteEventContent(pasteEvent({})).hasAnything).toBe(false)
  })

  it('keeps files, which carry no text/plain — otherwise an image paste is dropped', () => {
    const content = readPasteEventContent(pasteEvent({files: [anImage()]}))

    expect(content.text).toBe('')
    expect(content.files).toHaveLength(1)
    expect(content.hasAnything).toBe(true)
  })

  it('reports something to do for an EMPTY-block cut carrying our marker', () => {
    // Empty text with the marker is still a cut to complete; an emptiness
    // guard running before the payload was read would make that cut
    // permanently uncompletable from this surface.
    expect(readPasteEventContent(pasteEvent({html: encodePayloadHtml('', CUT)})).hasAnything).toBe(true)
  })

  it('reports NOTHING to do for an empty event, even with a cut remembered', () => {
    // Events read html only. A remembered cut belongs to the keyboard
    // path; honouring it here is how foreign plain text (and file-only
    // pastes) ended up matching a cut of an empty block.
    rememberPayload('', CUT)

    expect(readPasteEventContent(pasteEvent({})).hasAnything).toBe(false)
  })

  it('will not complete a remembered cut for a file-only paste from another app', () => {
    // An empty-block cut leaves empty text. An image copied elsewhere
    // arrives with files, empty text and no marker — recalling that cut
    // would move the block and throw the image away.
    rememberPayload('', CUT)

    const content = readPasteEventContent(pasteEvent({files: [anImage()]}))

    expect(content.payload).toBeNull()
    expect(content.files).toHaveLength(1)
  })

  it('still completes an in-app cut pasted alongside files, which carries the inline marker', () => {
    // The control: our own writes always include the html flavor, so
    // requiring it costs nothing on the in-app path.
    const content = readPasteEventContent(pasteEvent({
      text: 'hello', html: encodePayloadHtml('hello', CUT), files: [anImage()],
    }))

    expect(content.payload).toEqual(CUT)
  })

  it('leaves html undefined rather than empty-string when absent', () => {
    // `PasteRequest.html` is optional and downstream treats '' as present;
    // both handlers relied on the `|| undefined` this now owns.
    expect(readPasteEventContent(pasteEvent({text: 'x'})).html).toBeUndefined()
  })

  it('has no payload for ordinary content from another app', () => {
    const content = readPasteEventContent(pasteEvent({
      text: 'hello', html: '<meta charset="utf-8"><p>hello</p>',
    }))

    expect(content.payload).toBeNull()
    expect(content.hasAnything).toBe(true)
  })
})
