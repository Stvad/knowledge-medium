import { describe, expect, it } from 'vitest'
import { attachmentObjectPath, authenticatedObjectUrl } from './storagePaths.js'

describe('attachmentObjectPath', () => {
  it('is the flat <workspaceId>/<contentKey> layout', () => {
    expect(attachmentObjectPath('ws-1', 'deadbeef')).toBe('ws-1/deadbeef')
  })
})

describe('authenticatedObjectUrl', () => {
  it('matches the storage-js download shape — /object/<bucket>/<path>, no /authenticated/ segment', () => {
    expect(authenticatedObjectUrl('https://x.supabase.co', 'attachments', 'ws-1/deadbeef')).toBe(
      'https://x.supabase.co/storage/v1/object/attachments/ws-1/deadbeef',
    )
  })

  it('percent-encodes each path segment (preserving the slash separator)', () => {
    expect(authenticatedObjectUrl('https://x.supabase.co', 'attachments', 'ws 1/a b#c')).toBe(
      'https://x.supabase.co/storage/v1/object/attachments/ws%201/a%20b%23c',
    )
  })

  it('tolerates a trailing slash on the base url', () => {
    expect(authenticatedObjectUrl('https://x.supabase.co/', 'attachments', 'w/k')).toBe(
      'https://x.supabase.co/storage/v1/object/attachments/w/k',
    )
  })
})
