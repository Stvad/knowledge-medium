import { describe, expect, it } from 'vitest'
import { isEditorElement, shouldExitEditModeAfterBlur } from '@/utils/dom.ts'

describe('dom editor focus helpers', () => {
  it('treats textareas as editor elements', () => {
    const textarea = document.createElement('textarea')

    expect(isEditorElement(textarea)).toBe(true)
    expect(shouldExitEditModeAfterBlur(textarea)).toBe(false)
  })

  it('treats elements inside CodeMirror editors as editor elements', () => {
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const content = document.createElement('div')
    editor.appendChild(content)

    expect(isEditorElement(content)).toBe(true)
    expect(shouldExitEditModeAfterBlur(content)).toBe(false)
  })

  it('exits edit mode when focus lands outside an editor', () => {
    const button = document.createElement('button')

    expect(isEditorElement(button)).toBe(false)
    expect(shouldExitEditModeAfterBlur(button)).toBe(true)
    expect(shouldExitEditModeAfterBlur(null)).toBe(true)
  })
})
