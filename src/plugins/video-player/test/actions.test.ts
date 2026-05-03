import { describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import type { BlockInteractionContext, ShortcutSurfaceContext } from '@/extensions/blockInteraction.ts'
import {
  formatVideoTimestamp,
  VIDEO_PLAYER_CONTEXT,
  videoPlayerShortcutActivation,
} from '../actions.ts'

const noteBlock = {id: 'note'} as Block
const videoBlock = {id: 'video'} as Block

const baseContext = {
  block: noteBlock,
  repo: {
    block: vi.fn(() => videoBlock),
  } as unknown as Repo,
  uiStateBlock: {id: 'ui-state'} as Block,
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  blockContext: {
    videoPlayerBlockId: 'video',
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
})
