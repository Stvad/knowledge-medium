import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Block } from '../../data/block'
import { setFocusedBlockId } from '@/data/properties.ts'
import type { ShortcutActivationContribution } from '@/extensions/blockInteraction.ts'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type {
  ActionConfig,
  ActionContextConfig,
  BaseShortcutDependencies,
} from '@/shortcuts/types.ts'
import { requestCurrentTime } from './events.ts'
import { enterVideoNotesView } from './notes.ts'
import { videoPlayerViewProp } from './view.ts'

export const VIDEO_PLAYER_CONTEXT = 'video-player'

export interface VideoPlayerShortcutDependencies extends BaseShortcutDependencies {
  block: Block
  videoBlock: Block
  editorView?: EditorView
}

const isVideoPlayerShortcutDependencies = (
  deps: unknown,
): deps is VideoPlayerShortcutDependencies =>
  typeof deps === 'object' &&
  deps !== null &&
  'uiStateBlock' in deps &&
  deps.uiStateBlock instanceof Block &&
  'block' in deps &&
  deps.block instanceof Block &&
  'videoBlock' in deps &&
  deps.videoBlock instanceof Block &&
  (
    !('editorView' in deps) ||
    deps.editorView === undefined ||
    deps.editorView instanceof EditorView
  )

export const videoPlayerActionContext: ActionContextConfig = {
  type: VIDEO_PLAYER_CONTEXT,
  displayName: 'Video Player',
  validateDependencies: isVideoPlayerShortcutDependencies,
}

export const formatVideoTimestamp = (seconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60
  const paddedSeconds = remainingSeconds.toString().padStart(2, '0')

  if (hours === 0) return `${minutes}:${paddedSeconds}`

  return [
    hours,
    minutes.toString().padStart(2, '0'),
    paddedSeconds,
  ].join(':')
}

const insertIntoEditor = (editorView: EditorView, text: string): void => {
  editorView.dispatch(editorView.state.changeByRange(range => ({
    changes: {from: range.from, to: range.to, insert: text},
    range: EditorSelection.cursor(range.from + text.length),
  })))
  editorView.focus()
}

const appendToBlock = async (block: Block, text: string): Promise<void> => {
  const data = block.peek() ?? await block.load()
  if (!data) return

  const separator = data.content.trim().length > 0 ? ' ' : ''
  await block.setContent(`${data.content}${separator}${text.trim()}`)
}

const createTimestampNote = async (
  videoBlock: Block,
  uiStateBlock: Block,
  text: string,
): Promise<void> => {
  const newId = await videoBlock.repo.mutate.createChild({
    parentId: videoBlock.id,
    content: text.trim(),
    position: {kind: 'first'},
  }) as string

  if (newId) setFocusedBlockId(uiStateBlock, newId)
}

const insertVideoTimestamp: ActionConfig = {
  id: 'video.insert_timestamp',
  description: 'Insert current video timestamp',
  context: VIDEO_PLAYER_CONTEXT,
  handler: async (deps) => {
    if (!isVideoPlayerShortcutDependencies(deps)) return

    const currentTime = requestCurrentTime(deps.videoBlock.id)
    if (currentTime === undefined) return

    const timestamp = `${formatVideoTimestamp(currentTime)} `
    if (deps.editorView) {
      insertIntoEditor(deps.editorView, timestamp)
      return
    }

    if (deps.block.id === deps.videoBlock.id) {
      await createTimestampNote(deps.videoBlock, deps.uiStateBlock, timestamp)
      return
    }

    await appendToBlock(deps.block, timestamp)
  },
  defaultBinding: {
    keys: ['cmd+shift+t', 'ctrl+shift+t'],
    eventOptions: {
      preventDefault: true,
    },
  },
}

const toggleVideoNotesView: ActionConfig = {
  id: 'video.toggle_notes_view',
  description: 'Toggle video notes view',
  context: VIDEO_PLAYER_CONTEXT,
  handler: async (deps) => {
    if (!isVideoPlayerShortcutDependencies(deps)) return

    const currentView = deps.videoBlock.peekProperty(videoPlayerViewProp) ?? videoPlayerViewProp.defaultValue
    if (currentView === 'notes') {
      await deps.videoBlock.set(videoPlayerViewProp, 'default')
      return
    }

    await enterVideoNotesView(deps.videoBlock, deps.uiStateBlock)
  },
  defaultBinding: {
    keys: ['cmd+shift+n', 'ctrl+shift+n'],
    eventOptions: {
      preventDefault: true,
    },
  },
}

export const videoPlayerActions: readonly ActionConfig[] = [
  insertVideoTimestamp,
  toggleVideoNotesView,
]

export const videoPlayerShortcutActivation: ShortcutActivationContribution = context => {
  const videoBlockId = context.blockContext?.videoPlayerBlockId
  if (typeof videoBlockId !== 'string') return null

  const dependencies: Omit<VideoPlayerShortcutDependencies, 'uiStateBlock'> = {
    block: context.block,
    videoBlock: context.repo.block(videoBlockId),
  }

  if (context.surface === 'codemirror') {
    if (!context.editorView || context.block.id === videoBlockId) return null
    return [{
      context: VIDEO_PLAYER_CONTEXT,
      dependencies: {
        ...dependencies,
        editorView: context.editorView,
      },
    }]
  }

  if (context.surface !== 'block' || !context.inFocus || context.inEditMode || context.isSelected) {
    return null
  }

  return [{
    context: VIDEO_PLAYER_CONTEXT,
    dependencies,
  }]
}

export const videoPlayerActionsExtension: AppExtension = [
  actionContextsFacet.of(videoPlayerActionContext, {source: 'video-player'}),
  videoPlayerActions.map(action => actionsFacet.of(action, {source: 'video-player'})),
]
