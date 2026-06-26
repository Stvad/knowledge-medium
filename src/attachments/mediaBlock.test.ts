import { describe, expect, it } from 'vitest'
import { MEDIA_TYPE, MEDIA_TYPE_CONTRIBUTION, isImageMime, mediaHashProp } from './mediaBlock.js'

describe('isImageMime', () => {
  it('is true only for image/* MIME types', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/jpeg')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(true)
  })

  it('is false for non-image and malformed/absent types', () => {
    expect(isImageMime('application/pdf')).toBe(false)
    expect(isImageMime('text/plain')).toBe(false)
    expect(isImageMime('image')).toBe(false) // no slash — not a real image type
    expect(isImageMime('')).toBe(false)
    expect(isImageMime(undefined)).toBe(false)
  })

  it('is case-insensitive (MIME types are, even if File.type is lowercased)', () => {
    expect(isImageMime('IMAGE/PNG')).toBe(true)
    expect(isImageMime('Image/Gif')).toBe(true)
  })
})

describe('media type contribution', () => {
  it('lifts the render-critical hash field onto the media type (so addType materialises it)', () => {
    // The resolver can't address bytes without media:hash, so it must be a
    // property of the type — not merely set ad-hoc by capture.
    expect(MEDIA_TYPE_CONTRIBUTION.id).toBe(MEDIA_TYPE)
    expect(MEDIA_TYPE_CONTRIBUTION.properties).toContain(mediaHashProp)
  })
})
