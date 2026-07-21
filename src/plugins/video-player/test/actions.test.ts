// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import type { BlockInteractionContext, ShortcutSurfaceContext } from '@/extensions/blockInteraction.js'
import {
  editorFocusRequestProp,
  focusedBlockLocationProp,
  isEditingProp,
} from '@/data/properties.js'
import { registerVideoPlayer, type VideoPlayerHandle } from '../registry.ts'
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

const RENDER_SCOPE = 'embed:source:video:0'

// Register a stub player handle for the duration of a test. The actions
// resolve it through the typed registry (the request/response window
// bus is gone), keyed by block id + render scope.
const withVideoPlayer = async (
  blockId: string,
  handle: Partial<VideoPlayerHandle>,
  run: () => Promise<void>,
): Promise<void> => {
  const cleanup = registerVideoPlayer(blockId, RENDER_SCOPE, {
    getCurrentTime: () => undefined,
    focus: () => false,
    hasFocus: () => false,
    seekTo: () => {},
    ...handle,
  })
  try {
    await run()
  } finally {
    cleanup()
  }
}

const requireVideoAction = (id: string) => {
  const action = videoPlayerActions.find(candidate => candidate.id === id)
  if (!action) throw new Error(`missing video action ${id}`)
  return action
}

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
      tx: {
        get: (id: string) => Promise<{properties: Record<string, unknown>} | null>
        setProperty: (id: string, prop: unknown, value: unknown) => Promise<void>
      }
    ) => Promise<void>) => {
      await fn({
        get: async () => ({properties: {}}),
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
    const action = requireVideoAction('video.insert_timestamp')
    const deps: VideoPlayerShortcutDependencies = {
      block: scopedVideoBlock,
      videoBlock: scopedVideoBlock,
      uiStateBlock,
      renderScopeId: RENDER_SCOPE,
    }
    await withVideoPlayer('video', {getCurrentTime: () => 75}, async () => {
      await action.handler(deps, new CustomEvent('test'))
    })

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

  it('requests player focus from the rendered video when notes have focus', async () => {
    const action = requireVideoAction('video.toggle_focus')
    const focusRequests: string[] = []
    const deps: VideoPlayerShortcutDependencies = {
      block: fakeBlock({id: 'note'}),
      videoBlock: fakeBlock({id: 'video'}),
      uiStateBlock: fakeBlock({id: 'ui-state'}),
      renderScopeId: RENDER_SCOPE,
    }
    await withVideoPlayer('video', {
      hasFocus: () => false,
      focus: () => { focusRequests.push('video'); return true },
    }, async () => {
      await action.handler(deps, new CustomEvent('test'))
    })

    expect(focusRequests).toEqual(['video'])
  })

  it('returns focus to the active note when the rendered video already has focus', async () => {
    const action = requireVideoAction('video.toggle_focus')
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
      peekProperty: vi.fn((prop: unknown) =>
        prop === editorFocusRequestProp ? 0 : undefined,
      ),
      repo: {isReadOnly: false, tx},
      set: setUiProperty,
    })
    const scopedVideoBlock = fakeBlock({
      id: 'video',
      childIds: {load: vi.fn(async () => ['note'])},
      repo: {isReadOnly: false},
    })
    const deps: VideoPlayerShortcutDependencies = {
      block: fakeBlock({id: 'note'}),
      videoBlock: scopedVideoBlock,
      uiStateBlock,
      renderScopeId: RENDER_SCOPE,
    }
    await withVideoPlayer('video', {hasFocus: () => true}, async () => {
      await action.handler(deps, new CustomEvent('test'))
    })

    expect(setUiProperty).toHaveBeenCalledWith(focusedBlockLocationProp, {
      blockId: 'note',
      renderScopeId: 'embed:source:video:0',
    })
    expect(setUiProperty).toHaveBeenCalledWith(isEditingProp, true)
    expect(setUiProperty).toHaveBeenCalledWith(editorFocusRequestProp, 1)
  })
})
