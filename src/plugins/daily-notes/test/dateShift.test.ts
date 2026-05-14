// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb } from '@/data/test/createTestDb'
import { ActionContextTypes, type BlockShortcutDependencies, type CodeMirrorEditModeDependencies } from '@/shortcuts/types.ts'
import {
  DATE_SHIFT_BACKWARD_DAY_ACTION_ID,
  DATE_SHIFT_BACKWARD_WEEK_ACTION_ID,
  DATE_SHIFT_FORWARD_DAY_ACTION_ID,
  DATE_SHIFT_FORWARD_WEEK_ACTION_ID,
  dateReferenceShiftActions,
  shiftSingleDateReferenceContent,
} from '../dateShift.ts'

const fakeEditorView = (content: string) => {
  let text = content
  return {
    dispatch: vi.fn((spec: {changes?: {from: number; to: number; insert: string}}) => {
      if (!spec.changes) return
      text = text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to)
    }),
    state: {
      get doc() {
        return {
          length: text.length,
          toString: () => text,
        }
      },
    },
  }
}

describe('shiftSingleDateReferenceContent', () => {
  it('shifts a single ISO date wikilink while preserving ISO style', () => {
    expect(shiftSingleDateReferenceContent('due [[2026-05-01]]', 1))
      .toBe('due [[2026-05-02]]')
    expect(shiftSingleDateReferenceContent('due [[2026-05-01]]', -7))
      .toBe('due [[2026-04-24]]')
  })

  it('shifts a single Roam long-form date wikilink while preserving long style', () => {
    expect(shiftSingleDateReferenceContent('due [[May 1st, 2026]]', 7))
      .toBe('due [[May 8th, 2026]]')
  })

  it('no-ops when there are zero or multiple date references', () => {
    expect(shiftSingleDateReferenceContent('due [[Project]]', 1)).toBeNull()
    expect(shiftSingleDateReferenceContent('[[2026-05-01]] and [[2026-05-02]]', 1)).toBeNull()
  })

  it('ignores non-date references when exactly one date reference is present', () => {
    expect(shiftSingleDateReferenceContent('see [[Project]] by [[2026-05-01]]', 1))
      .toBe('see [[Project]] by [[2026-05-02]]')
  })
})

describe('dateReferenceShiftActions', () => {
  it('contributes normal and edit-mode actions with requested default bindings', () => {
    const actions = dateReferenceShiftActions

    expect(actions.map(action => [action.id, action.context, action.defaultBinding?.keys])).toEqual([
      [DATE_SHIFT_FORWARD_DAY_ACTION_ID, ActionContextTypes.NORMAL_MODE, ['ctrl+alt+up', 'ctrl+alt+h']],
      [DATE_SHIFT_BACKWARD_DAY_ACTION_ID, ActionContextTypes.NORMAL_MODE, ['ctrl+alt+down', 'ctrl+alt+k']],
      [DATE_SHIFT_FORWARD_WEEK_ACTION_ID, ActionContextTypes.NORMAL_MODE, ['ctrl+shift+up', 'ctrl+shift+h']],
      [DATE_SHIFT_BACKWARD_WEEK_ACTION_ID, ActionContextTypes.NORMAL_MODE, ['ctrl+shift+down', 'ctrl+shift+k']],
      [DATE_SHIFT_FORWARD_DAY_ACTION_ID, ActionContextTypes.EDIT_MODE_CM, ['ctrl+alt+up', 'ctrl+alt+h']],
      [DATE_SHIFT_BACKWARD_DAY_ACTION_ID, ActionContextTypes.EDIT_MODE_CM, ['ctrl+alt+down', 'ctrl+alt+k']],
      [DATE_SHIFT_FORWARD_WEEK_ACTION_ID, ActionContextTypes.EDIT_MODE_CM, ['ctrl+shift+up', 'ctrl+shift+h']],
      [DATE_SHIFT_BACKWARD_WEEK_ACTION_ID, ActionContextTypes.EDIT_MODE_CM, ['ctrl+shift+down', 'ctrl+shift+k']],
    ])
  })

  it('updates a normal-mode block with exactly one date reference', async () => {
    const h = await createTestDb()
    try {
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        registerKernelProcessors: false,
      })
      await repo.tx(tx => tx.create({
        id: 'block',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'due [[2026-05-01]]',
      }), {scope: ChangeScope.BlockDefault})

      const action = dateReferenceShiftActions.find(candidate =>
        candidate.id === DATE_SHIFT_FORWARD_DAY_ACTION_ID &&
        candidate.context === ActionContextTypes.NORMAL_MODE,
      )!
      const block = repo.block('block')
      await block.load()

      await action.handler({block, uiStateBlock: block} as BlockShortcutDependencies, {} as KeyboardEvent)

      expect(block.peek()?.content).toBe('due [[2026-05-02]]')
    } finally {
      await h.cleanup()
    }
  })

  it('updates the live CodeMirror doc and persisted content in edit mode', async () => {
    const h = await createTestDb()
    try {
      const repo = new Repo({
        db: h.db,
        cache: new BlockCache(),
        user: {id: 'user-1'},
        registerKernelProcessors: false,
      })
      await repo.tx(tx => tx.create({
        id: 'block',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'stale [[2026-05-01]]',
      }), {scope: ChangeScope.BlockDefault})

      const action = dateReferenceShiftActions.find(candidate =>
        candidate.id === DATE_SHIFT_FORWARD_WEEK_ACTION_ID &&
        candidate.context === ActionContextTypes.EDIT_MODE_CM,
      )!
      const block = repo.block('block')
      await block.load()
      const editorView = fakeEditorView('live [[2026-05-01]]')

      await action.handler({
        block,
        uiStateBlock: block,
        editorView,
      } as unknown as CodeMirrorEditModeDependencies, {} as KeyboardEvent)

      expect(editorView.state.doc.toString()).toBe('live [[2026-05-08]]')
      expect(block.peek()?.content).toBe('live [[2026-05-08]]')
    } finally {
      await h.cleanup()
    }
  })
})
