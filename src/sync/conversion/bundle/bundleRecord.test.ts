import { describe, expect, it } from 'vitest'
import { emptyBundleRecord } from '../test/flowFixtures.js'
import { storedBundleRecord } from './bundleRecord.js'

describe('storedBundleRecord', () => {
  it('reads a record without the attachment lists as none: its bundle has no attachment parts', () => {
    const older: Record<string, unknown> = {...emptyBundleRecord()}
    delete older.otherObjectPaths
    delete older.noVerifiedSource

    expect(storedBundleRecord(older)).toBeNull()
    expect(storedBundleRecord({...older, otherObjectPaths: []})).toBeNull()
    expect(storedBundleRecord(undefined)).toBeNull()
  })

  it('keeps a record with them', () => {
    const record = emptyBundleRecord()

    expect(storedBundleRecord(record)).toBe(record)
  })
})
