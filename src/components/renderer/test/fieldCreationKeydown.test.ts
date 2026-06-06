// @vitest-environment jsdom
/**
 * The `>` field-creation keydown guard from CodeMirrorContentRenderer. The
 * effect (convertEmptyChildBlockToProperty) is tested in propertyCreation.test;
 * this pins WHEN the shortcut fires — only a plain `>` in an empty, top-of-doc
 * child block, never a normal `>` in prose, a chord, a read-only repo, or a
 * root/parentless block. The guard returns true (handled) only when it fires,
 * so a fall-through leaves CodeMirror to insert the character.
 */

import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/propertyCreation.js', () => ({
  convertEmptyChildBlockToProperty: vi.fn(async () => undefined),
}))

import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation.js'
import { handleFieldCreationKeydown } from '../fieldCreationKeydown.ts'
import type { Repo } from '@/data/repo'
import type { BlockRendererProps } from '@/types'

const convertMock = vi.mocked(convertEmptyChildBlockToProperty)

interface Opts {
  doc?: string
  readOnly?: boolean
  parentId?: string | null
}

// Only `view.state` is read by the guard, so a state-only stand-in is enough.
const fire = (opts: Opts = {}, eventInit: KeyboardEventInit = {}): boolean => {
  const block = {
    id: 'b1',
    peek: () => ({ parentId: opts.parentId === undefined ? 'parent-1' : opts.parentId }),
  } as unknown as BlockRendererProps['block']
  const repo = { isReadOnly: opts.readOnly ?? false } as unknown as Repo
  const view = { state: EditorState.create({ doc: opts.doc ?? '' }) } as unknown as EditorView
  const event = new KeyboardEvent('keydown', { key: '>', cancelable: true, ...eventInit })
  return handleFieldCreationKeydown(event, view, block, repo)
}

afterEach(() => convertMock.mockClear())

describe('handleFieldCreationKeydown', () => {
  it('converts an empty child block to a property field on a plain ">"', () => {
    expect(fire()).toBe(true)
    expect(convertMock).toHaveBeenCalledTimes(1)
    expect(convertMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      expect.anything(),
    )
  })

  it('falls through when the block already has content', () => {
    expect(fire({ doc: 'already typed' })).toBe(false)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('falls through on a read-only repo', () => {
    expect(fire({ readOnly: true })).toBe(false)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('falls through on a root block (no parent to attach the field to)', () => {
    expect(fire({ parentId: null })).toBe(false)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('falls through on a ">" chord so the shortcut layer can own it', () => {
    expect(fire({}, { metaKey: true })).toBe(false)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('falls through on any non-">" key', () => {
    expect(fire({}, { key: 'a' })).toBe(false)
    expect(convertMock).not.toHaveBeenCalled()
  })
})
