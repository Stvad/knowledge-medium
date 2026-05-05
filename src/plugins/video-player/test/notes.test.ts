import { describe, expect, it, vi } from 'vitest'
import type { Block } from '../../../data/block'
import {
  editorFocusRequestProp,
  editorSelection,
  focusedBlockIdProp,
  isEditingProp,
} from '@/data/properties.ts'
import { enterVideoNotesView } from '../notes.ts'
import { videoPlayerViewProp } from '../view.ts'

const makeBlocks = ({
  childIds = [],
  readOnly = false,
}: {
  childIds?: string[]
  readOnly?: boolean
} = {}) => {
  const createChild = vi.fn(async () => 'note-1')
  const loadChildIds = vi.fn(async () => childIds)
  const setVideoProperty = vi.fn(async () => undefined)
  const setUiProperty = vi.fn(async () => undefined)
  const peekUiProperty = vi.fn((prop: unknown) =>
    prop === editorFocusRequestProp ? 0 : undefined,
  )

  const videoBlock = {
    id: 'video-1',
    childIds: {load: loadChildIds},
    repo: {
      isReadOnly: readOnly,
      mutate: {createChild},
    },
    set: setVideoProperty,
  } as unknown as Block

  const uiStateBlock = {
    id: 'ui-state',
    peekProperty: peekUiProperty,
    repo: {isReadOnly: readOnly},
    set: setUiProperty,
  } as unknown as Block

  return {
    createChild,
    loadChildIds,
    setUiProperty,
    setVideoProperty,
    uiStateBlock,
    videoBlock,
  }
}

describe('video notes view', () => {
  it('creates and focuses an editable first note when entering notes view without children', async () => {
    const {createChild, setUiProperty, setVideoProperty, uiStateBlock, videoBlock} = makeBlocks()

    await enterVideoNotesView(videoBlock, uiStateBlock)

    expect(setVideoProperty).toHaveBeenCalledWith(videoPlayerViewProp, 'notes')
    expect(createChild).toHaveBeenCalledWith({
      parentId: 'video-1',
      position: {kind: 'first'},
    })
    expect(setUiProperty).toHaveBeenCalledWith(focusedBlockIdProp, 'note-1')
    expect(setUiProperty).toHaveBeenCalledWith(editorSelection, {
      blockId: 'note-1',
      start: 0,
    })
    expect(setUiProperty).toHaveBeenCalledWith(isEditingProp, true)
    expect(setUiProperty).toHaveBeenCalledWith(editorFocusRequestProp, 1)
  })

  it('does not create a new note when the video already has children', async () => {
    const {
      createChild,
      loadChildIds,
      setUiProperty,
      uiStateBlock,
      videoBlock,
    } = makeBlocks({childIds: ['existing-note']})

    await enterVideoNotesView(videoBlock, uiStateBlock)

    expect(loadChildIds).toHaveBeenCalled()
    expect(createChild).not.toHaveBeenCalled()
    expect(setUiProperty).not.toHaveBeenCalled()
  })

  it('does not create an editable note in read-only workspaces', async () => {
    const {
      createChild,
      loadChildIds,
      setUiProperty,
      uiStateBlock,
      videoBlock,
    } = makeBlocks({readOnly: true})

    await enterVideoNotesView(videoBlock, uiStateBlock)

    expect(loadChildIds).not.toHaveBeenCalled()
    expect(createChild).not.toHaveBeenCalled()
    expect(setUiProperty).not.toHaveBeenCalled()
  })
})
