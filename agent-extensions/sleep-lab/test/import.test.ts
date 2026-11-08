/** Unit tier for the file-picking filters ahead of the two importers:
 *  `isImportFile` (src/import/index.ts), the ImportDialog's own gate before
 *  it calls `file.text()` on anything picked, and `isSamsungFileOfInterest`
 *  (src/import/samsungExport.ts) it composes for the Samsung export half.
 *  No repo, no parsing — just names in, booleans out. */
import {describe, expect, it} from 'vitest'

import {isImportFile} from '../src/import'
import {isSamsungFileOfInterest} from '../src/import/samsungExport'

describe('isSamsungFileOfInterest / isImportFile — files the importers actually read', () => {
  const wanted = [
    'samsunghealth_x/com.samsung.shealth.sleep.1.csv',
    'samsunghealth_x/com.samsung.health.sleep_stage.1.csv',
    'samsunghealth_x/com.samsung.shealth.tracker.heart_rate.1.csv',
    'samsunghealth_x/com.samsung.shealth.tracker.oxygen_saturation.1.csv',
    'samsunghealth_x/com.samsung.health.skin_temperature.1.csv',
    'samsunghealth_x/com.samsung.health.respiratory_rate.1.csv',
    'samsunghealth_x/com.samsung.health.hrv.1.csv',
    'samsunghealth_x/jsons/com.samsung.health.hrv/9/a.binning_data.json',
  ]

  it.each(wanted)('%s is a Samsung file of interest, and a file to import', name => {
    expect(isSamsungFileOfInterest(name)).toBe(true)
    expect(isImportFile(name)).toBe(true)
  })

  it('a bare pasted/uploaded payload.json is a file to import, though it is not a Samsung file', () => {
    expect(isSamsungFileOfInterest('payload.json')).toBe(false)
    expect(isImportFile('payload.json')).toBe(true)
  })
})

describe('isSamsungFileOfInterest / isImportFile — files the importers do NOT read', () => {
  const unwanted = [
    // Segment 'oxygen_saturation.raw', not 'oxygen_saturation' — the raw
    // series sits beside the per-night mean this importer wants.
    'samsunghealth_x/com.samsung.health.oxygen_saturation.raw.1.csv',
    // 'recovery_heart_rate' is its own dotted segment, distinct from
    // 'heart_rate' — matched by exact segment, not substring.
    'samsunghealth_x/com.samsung.shealth.exercise.recovery_heart_rate.1.csv',
    // 'sleep_snoring', not 'sleep' or 'sleep_stage'.
    'samsunghealth_x/com.samsung.shealth.sleep_snoring.1.csv',
    // Per-minute detail JSON under jsons/ for a series this importer only
    // reads the CSV summary of (heart rate) — excluded by the jsons/ guard.
    'samsunghealth_x/jsons/com.samsung.shealth.tracker.heart_rate/9/b.json',
    'samsunghealth_x/com.samsung.shealth.step_daily_trend.1.csv',
  ]

  it.each(unwanted)('%s is neither a Samsung file of interest nor a file to import', name => {
    expect(isSamsungFileOfInterest(name)).toBe(false)
    expect(isImportFile(name)).toBe(false)
  })
})
