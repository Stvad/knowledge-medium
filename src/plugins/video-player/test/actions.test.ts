// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import type { BlockInteractionContext, ShortcutSurfaceContext } from '@/extensions/blockInteraction.js'
import { focusedBlockLocationProp } from '@/data/properties.js'
import { currentTimeRequestEventName, type CurrentTimeRequestEventDetail } from '../events.ts'
import {
  formatVideoTimestamp,
  VIDEO_PLAYER_CONTEXT,
  type VideoPlayerShortcutDependencies,
  videoPlayerActions,
  videoPlayerShortcutActivation,
} from '../actions.ts'

const noteBlock = {id: 'note'} as Block
const videoBlock = {id: 'video'} as Block

const fakeBlock = <T extends object>(shape: T): Block & T =>
  Object.setPrototypeOf(shape, Block.prototype) as Block & T

const baseContext = {
  block: noteBlock,
  repo: {
    block: vi.fn(() => videoBlock),
  } as unknown as Repo,
  uiStateBlock: {id: 'ui-state'} as Block,
  types: [],
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  blockContext: {
    videoPlayerBlockId: 'video',
    renderScopeId: 'embed:source:video:0',
  },
} satisfies BlockInteractionContext

describe('video player actions', () => {
  it('formats current playback time as markdown timestamp text', () => {
    expect(formatVideoTimestamp(5.9)).toBe('0:05')
    expect(formatVideoTimestamp(75)).toBe('1:15')
    expect(formatVideoTimestamp(3675)).toBe('1:01:15')
  })

  it('activates the video-player context for note blocks inside a video subtree', () => {
    const activation = videoPlayerShortcutActivation({
      ...baseContext,
      surface: 'block',
    })

    expect(activation).toEqual([{
      context: VIDEO_PLAYER_CONTEXT,
      dependencies: {
        block: noteBlock,
        videoBlock,
        renderScopeId: 'embed:source:video:0',
      },
    }])
  })

  it('carries the editor view when the active shortcut surface is CodeMirror', () => {
    const editorView = {} as EditorView
    const activation = videoPlayerShortcutActivation({
      ...baseContext,
      surface: 'codemirror',
      editorView,
    } satisfies ShortcutSurfaceContext)

    expect(activation).toEqual([{
      context: VIDEO_PLAYER_CONTEXT,
      dependencies: {
        block: noteBlock,
        videoBlock,
        renderScopeId: 'embed:source:video:0',
        editorView,
      },
    }])
  })

  it('does not activate timestamp insertion while editing the video URL block itself', () => {
    expect(videoPlayerShortcutActivation({
      ...baseContext,
      block: videoBlock,
      surface: 'codemirror',
      editorView: {} as EditorView,
    } satisfies ShortcutSurfaceContext)).toBeNull()
  })

  it('focuses created timestamp notes in the current render scope', async () => {
    const setUiProperty = vi.fn()
    const tx = vi.fn(async (fn: (
      tx: {setProperty: (id: string, prop: unknown, value: unknown) => Promise<void>}
    ) => Promise<void>) => {
      await fn({
        setProperty: async (_id, prop, value) => {
          setUiProperty(prop, value)
        },
      })
    })
    const uiStateBlock = fakeBlock({
      id: 'ui-state',
      peek: vi.fn(() => ({properties: {}})),
      peekProperty: vi.fn(() => undefined),
      repo: {isReadOnly: false, tx},
    })
    const createChild = vi.fn(async () => 'note-1')
    const scopedVideoBlock = fakeBlock({
      id: 'video',
      repo: {mutate: {createChild}},
    })
    const respondWithTime = (event: Event) => {
      const request = event as CustomEvent<CurrentTimeRequestEventDetail>
      if (request.detail.blockId === 'video') request.detail.respond(75)
    }
    window.addEventListener(currentTimeRequestEventName, respondWithTime)

    try {
      const action = videoPlayerActions.find(candidate => candidate.id === 'video.insert_timestamp')
      if (!action) throw new Error('missing video timestamp action')

      const deps: VideoPlayerShortcutDependencies = {
        block: scopedVideoBlock,
        videoBlock: scopedVideoBlock,
        uiStateBlock,
        renderScopeId: 'embed:source:video:0',
      }
      await action.handler(deps, new CustomEvent('test'))
    } finally {
      window.removeEventListener(currentTimeRequestEventName, respondWithTime)
    }

    expect(createChild).toHaveBeenCalledWith({
      parentId: 'video',
      content: '1:15',
      position: {kind: 'first'},
    })
    expect(setUiProperty).toHaveBeenCalledWith(focusedBlockLocationProp, {
      blockId: 'note-1',
      renderScopeId: 'embed:source:video:0',
    })
  })
})
