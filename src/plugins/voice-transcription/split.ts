import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { keyBetween } from '@/data/orderKey.ts'
import type { CodeMirrorExtensionContribution } from '@/extensions/editor.ts'
import { hasBlockType } from '@/data/properties.ts'
import { splitSegmentTimeRange } from './model.ts'
import { transcriptSegmentTimingPatch } from './blocks.ts'
import {
  TRANSCRIPT_SEGMENT_TYPE,
  transcriptSegmentEndMsProp,
  transcriptSegmentStartMsProp,
} from './schema.ts'

const isTranscriptSegmentBlock = (block: Block): boolean => {
  const data = block.peek()
  return Boolean(data && hasBlockType(data, TRANSCRIPT_SEGMENT_TYPE))
}

export const splitTranscriptSegmentAtCursor = async (
  block: Block,
  editorView: EditorView,
): Promise<boolean> => {
  if (!isTranscriptSegmentBlock(block)) return false

  const doc = editorView.state.doc
  const selection = editorView.state.selection.main
  if (!selection.empty) return false
  if (selection.head <= 0 || selection.head >= doc.length) return false

  const data = block.peek() ?? await block.load()
  if (!data || data.parentId === null) return false

  const startMs = block.peekProperty(transcriptSegmentStartMsProp)
  const endMs = block.peekProperty(transcriptSegmentEndMsProp)
  if (startMs === undefined || endMs === undefined) return false

  const before = doc.sliceString(0, selection.head)
  const after = doc.sliceString(selection.head)
  const splitMs = splitSegmentTimeRange(startMs, endMs, doc.length, selection.head)

  editorView.dispatch({
    changes: {from: 0, to: doc.length, insert: after},
    selection: EditorSelection.cursor(0),
  })

  await block.repo.tx(async tx => {
    const self = await tx.get(block.id)
    if (!self || self.parentId === null) return

    await tx.update(block.id, {
      content: after,
      properties: transcriptSegmentTimingPatch(self.properties, splitMs, endMs),
    })

    const siblings = await tx.childrenOf(self.parentId, self.workspaceId)
    const ix = siblings.findIndex(sibling => sibling.id === self.id)
    const prev = ix >= 0 ? siblings[ix - 1] : undefined
    const orderKey = keyBetween(prev?.orderKey ?? null, self.orderKey)

    await tx.create({
      workspaceId: self.workspaceId,
      parentId: self.parentId,
      orderKey,
      content: before,
      properties: transcriptSegmentTimingPatch(self.properties, startMs, splitMs),
    })
  }, {scope: ChangeScope.BlockDefault, description: 'split transcript segment'})

  return true
}

export const transcriptSegmentCodeMirrorExtensions: CodeMirrorExtensionContribution = ({block}) => {
  if (!isTranscriptSegmentBlock(block)) return []

  return [
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (
          event.key !== 'Enter' ||
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        ) {
          return false
        }

        const selection = view.state.selection.main
        if (!selection.empty || selection.head <= 0 || selection.head >= view.state.doc.length) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()
        void splitTranscriptSegmentAtCursor(block, view).catch(error => {
          console.error('[voice-transcription] Failed to split transcript segment', error)
        })
        return true
      },
    }),
  ]
}
