import { describe, expect, it } from 'vitest'
import { emptyBundleRecord } from '../test/flowFixtures.js'
import { storedBundleRecord } from './bundleRecord.js'

describe('storedBundleRecord', () => {
  it('reads a record without the attachment lists or the media as none: its bundle predates them', () => {
    const older: Record<string, unknown> = {...emptyBundleRecord()}
    delete older.otherObjectPaths
    delete older.noVerifiedSource
    const withoutMedia: Record<string, unknown> = {...emptyBundleRecord()}
    delete withoutMedia.media

    expect(storedBundleRecord(older)).toBeNull()
    expect(storedBundleRecord({...older, otherObjectPaths: []})).toBeNull()
    expect(storedBundleRecord(withoutMedia)).toBeNull()
    expect(storedBundleRecord(undefined)).toBeNull()
  })

  it('keeps a record with them', () => {
    const record = emptyBundleRecord()

    expect(storedBundleRecord(record)).toBe(record)
  })
})
