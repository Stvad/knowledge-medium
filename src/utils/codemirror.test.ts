import { EditorSelection, EditorState, type Extension, type StateCommand, type Transaction } from '@codemirror/state'
import { completionKeymap } from '@codemirror/autocomplete'
import { describe, expect, it } from 'vitest'
import {
  createMinimalMarkdownConfig,
  toggleMarkdownBold,
  toggleMarkdownInlineCode,
  toggleMarkdownItalic,
  toggleMarkdownStrikethrough,
} from '@/utils/codemirror.js'
import { completionKeymapWithEscapeFallthrough } from '@/utils/codemirrorCompletion.js'

const runCommand = (
  command: StateCommand,
  doc: string,
  anchor: number,
  head = anchor,
) => {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create([EditorSelection.range(anchor, head)]),
  })

  command({
    state,
    dispatch: (transaction: Transaction) => {
      state = transaction.state
    },
  })

  const selection = state.selection.main
  return {
    doc: state.doc.toString(),
    from: selection.from,
    to: selection.to,
    head: selection.head,
  }
}

type StyleModuleExtension = {
  value?: {
    rules?: readonly string[]
  }
}

const collectThemeRules = (extensions: readonly Extension[]) => {
  const stack: unknown[] = [...extensions]
  const rules: string[] = []

  while (stack.length > 0) {
    const extension = stack.pop()
    if (Array.isArray(extension)) {
      stack.push(...extension)
      continue
    }

    const maybeRules = (extension as StyleModuleExtension | undefined)?.value?.rules
    if (Array.isArray(maybeRules)) rules.push(...maybeRules)
  }

  return rules
}

describe('markdown formatting CodeMirror commands', () => {
  it('wraps selected text in bold markers and keeps the text selected', () => {
    expect(runCommand(toggleMarkdownBold, 'make bold now', 5, 9)).toEqual({
      doc: 'make **bold** now',
      from: 7,
      to: 11,
      head: 11,
    })
  })

  it('inserts an empty bold pair at the cursor', () => {
    expect(runCommand(toggleMarkdownBold, 'hello ', 6)).toEqual({
      doc: 'hello ****',
      from: 8,
      to: 8,
      head: 8,
    })
  })

  it('removes surrounding bold markers from selected text', () => {
    expect(runCommand(toggleMarkdownBold, '**bold**', 2, 6)).toEqual({
      doc: 'bold',
      from: 0,
      to: 4,
      head: 4,
    })
  })

  it('removes bold markers included in the selection', () => {
    expect(runCommand(toggleMarkdownBold, '**bold**', 0, 8)).toEqual({
      doc: 'bold',
      from: 0,
      to: 4,
      head: 4,
    })
  })

  it('supports italic, inline code, and strikethrough markers', () => {
    expect(runCommand(toggleMarkdownItalic, 'word', 0, 4).doc).toBe('*word*')
    expect(runCommand(toggleMarkdownInlineCode, 'word', 0, 4).doc).toBe('`word`')
    expect(runCommand(toggleMarkdownStrikethrough, 'word', 0, 4).doc).toBe('~~word~~')
  })
})

describe('minimal markdown CodeMirror config', () => {
  it('removes the focus outline from the focused editor root', () => {
    expect(collectThemeRules(createMinimalMarkdownConfig())).toContainEqual(
      expect.stringMatching(/^\.\S+\.cm-focused \{outline: none;\}$/),
    )
  })
})

describe('completion keymap behavior', () => {
  it('lets Escape fall through while preserving the rest of CodeMirror completion navigation', () => {
    const bindingKeys = (binding: {key?: string, mac?: string, linux?: string, win?: string}) =>
      [binding.key, binding.mac, binding.linux, binding.win].filter((key): key is string => key !== undefined)
    const originalKeys = completionKeymap.flatMap(bindingKeys)
    const configuredKeys = completionKeymapWithEscapeFallthrough.flatMap(bindingKeys)

    expect(originalKeys).toContain('Escape')
    expect(configuredKeys).not.toContain('Escape')
    expect(configuredKeys).toEqual(originalKeys.filter(key => key !== 'Escape'))
    expect(completionKeymapWithEscapeFallthrough).toContainEqual(
      expect.objectContaining({key: 'ArrowDown', stopPropagation: true}),
    )
  })
})
