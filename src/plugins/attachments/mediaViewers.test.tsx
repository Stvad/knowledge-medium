import { describe, expect, it } from 'vitest'
import { FILE_VIEWER_FALLBACK, MEDIA_VIEWERS, formatByteSize, pickMediaViewer } from './mediaViewers.js'

describe('pickMediaViewer', () => {
  it('routes image mimes to the image viewer and everything else to the file fallback', () => {
    const imageViewer = MEDIA_VIEWERS[0]
    expect(pickMediaViewer('image/png')).toBe(imageViewer)
    expect(pickMediaViewer('IMAGE/PNG')).toBe(imageViewer) // MIME is case-insensitive (RFC 2045)
    expect(pickMediaViewer('application/pdf')).toBe(FILE_VIEWER_FALLBACK)
    expect(pickMediaViewer('audio/mpeg')).toBe(FILE_VIEWER_FALLBACK)
    expect(pickMediaViewer('')).toBe(FILE_VIEWER_FALLBACK)
  })
})

describe('formatByteSize', () => {
  it('scales to binary units, one decimal below 10, whole above', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(1536)).toBe('1.5 KB')
    expect(formatByteSize(1024 * 1024)).toBe('1 MB')
    expect(formatByteSize(2_100_000)).toBe('2 MB')
    expect(formatByteSize(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatByteSize(1024 ** 3)).toBe('1 GB')
  })
})
