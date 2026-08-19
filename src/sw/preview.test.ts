import {describe, expect, it} from 'vitest'
import {isForeignPreviewRequest} from './preview'

describe('isForeignPreviewRequest', () => {
  const previewPath = '/knowledge-medium/pr-preview/pr-309/src/main.js'
  const prodPath = '/knowledge-medium/src/main.js'

  it('a production-scoped SW treats a preview subtree as foreign (hands off to network)', () => {
    expect(isForeignPreviewRequest(false, previewPath)).toBe(true)
  })

  it('a production-scoped SW owns its own non-preview paths', () => {
    expect(isForeignPreviewRequest(false, prodPath)).toBe(false)
  })

  it('a preview-scoped SW owns its own subtree (never foreign to itself)', () => {
    expect(isForeignPreviewRequest(true, previewPath)).toBe(false)
  })
})
