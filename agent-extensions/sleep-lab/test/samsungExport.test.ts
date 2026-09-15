import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {detectImport, importSessions} from '../src/import/index'
import {parseSamsungExport, parseSamsungInstant} from '../src/import/samsungExport'

const read = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

// The whole export folder, laid out the way the real "Download personal
// data" export does: two sleep sessions (a main night ending 16:33Z — 09:33
// America/Los_Angeles, well inside the wake window — and a 40-minute nap),
// a dozen-odd stage rows, and one vitals file per kind.
const files = () => [
  {name: 'com.samsung.shealth.sleep.20260907.csv', text: read('samsungSleep.csv')},
  {name: 'com.samsung.health.sleep_stage.20260907.csv', text: read('samsungSleepStage.csv')},
  {name: 'com.samsung.shealth.tracker.heart_rate.20260907.csv', text: read('samsungHeartRate.csv')},
  {name: 'com.samsung.health.skin_temperature.20260907.csv', text: read('samsungSkinTemp.csv')},
  {name: 'com.samsung.health.respiratory_rate.20260907.csv', text: read('samsungRespRate.csv')},
  {name: 'com.samsung.shealth.tracker.oxygen_saturation.20260907.csv', text: read('samsungOxygen.csv')},
  {name: 'com.samsung.shealth.tracker.oxygen_saturation.raw.20260907.csv', text: read('samsungOxygenRaw.csv')},
  {name: 'com.samsung.health.hrv.20260907.csv', text: read('samsungHrv.csv')},
  {name: 'samsunghealth_x/jsons/com.samsung.health.hrv/9/abc123.binning_data.json', text: read('samsungHrvBinning.json')},
]

// A single minimal session row, for the edge-case tests below that don't
// care about the main fixture's content but still need at least one
// sleep-session file present (parseSamsungExport bails out early otherwise).
const minimalSessionFile = {
  name: 'com.samsung.shealth.sleep.minimal.csv',
  text: [
    '#com.samsung.health.sleep',
    'com.samsung.health.sleep.start_time,com.samsung.health.sleep.end_time,com.samsung.health.sleep.datauuid',
    '2026-01-01 00:00:00.000,2026-01-01 08:00:00.000,ssn-min',
  ].join('\n'),
}

describe('parseSamsungInstant', () => {
  it('reads a Samsung timestamp as UTC, ignoring any time_offset entirely', () => {
    expect(parseSamsungInstant('2026-09-07 08:59:00.000')?.getTime()).toBe(Date.UTC(2026, 8, 7, 8, 59))
  })
})

describe('parseSamsungExport: sessions', () => {
  it('reads the two well-formed sessions and skips the row with no start_time', () => {
    const {sessions} = parseSamsungExport(files())
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.externalId).sort()).toEqual(['ssn-main-1', 'ssn-nap-1'])
  })

  it('reads exact UTC instants for the main session, unaffected by time_offset', () => {
    const {sessions} = parseSamsungExport(files())
    const main = sessions.find(s => s.externalId === 'ssn-main-1')!
    expect(main.source).toBe('samsung-export')
    expect(main.start.getTime()).toBe(Date.UTC(2026, 8, 7, 8, 59))
    expect(main.end.getTime()).toBe(Date.UTC(2026, 8, 7, 16, 33))
  })

  it('reads exact UTC instants for the nap', () => {
    const {sessions} = parseSamsungExport(files())
    const nap = sessions.find(s => s.externalId === 'ssn-nap-1')!
    expect(nap.start.getTime()).toBe(Date.UTC(2026, 8, 7, 21, 0))
    expect(nap.end.getTime()).toBe(Date.UTC(2026, 8, 7, 21, 40))
  })

  it('states inBedMinutes, onsetMinutes (ms/60000), remMinutes, lightMinutes, efficiency (0-1) and score off the main row', () => {
    const {sessions} = parseSamsungExport(files())
    const main = sessions.find(s => s.externalId === 'ssn-main-1')!
    expect(main.stated).toEqual({
      efficiency: 0.9,
      score: 87,
      inBedMinutes: 454,
      onsetMinutes: 7, // 420000 ms / 60000
      remMinutes: 88,
      lightMinutes: 210,
    })
  })

  it('omits fields the nap row left blank, and omits onsetMinutes for a negative sleep_latency', () => {
    const {sessions} = parseSamsungExport(files())
    const nap = sessions.find(s => s.externalId === 'ssn-nap-1')!
    expect(nap.stated).toEqual({inBedMinutes: 40, lightMinutes: 35})
  })
})

describe('parseSamsungExport: stages', () => {
  it('joins stages to the main session by sleep_id, sorted by start, mapping stage codes and keeping an unrecognized one as \'unknown\'', () => {
    const {sessions} = parseSamsungExport(files())
    const main = sessions.find(s => s.externalId === 'ssn-main-1')!
    expect(main.stages.map(s => s.kind)).toEqual([
      'awake', 'light', 'deep', 'rem', 'light', 'awake', 'deep', 'rem', 'unknown', 'light',
    ])
    expect(main.stages[0].start.getTime()).toBe(Date.UTC(2026, 8, 7, 8, 59))
    expect(main.stages[0].end.getTime()).toBe(Date.UTC(2026, 8, 7, 9, 7))
    expect(main.stages.at(-1)!.end.getTime()).toBe(Date.UTC(2026, 8, 7, 16, 33))
  })

  it('falls back to interval containment for a stage row with no sleep_id', () => {
    const {sessions} = parseSamsungExport(files())
    const nap = sessions.find(s => s.externalId === 'ssn-nap-1')!
    expect(nap.stages).toHaveLength(1)
    expect(nap.stages[0].kind).toBe('light')
    expect(nap.stages[0].start.getTime()).toBe(Date.UTC(2026, 8, 7, 21, 0))
    expect(nap.stages[0].end.getTime()).toBe(Date.UTC(2026, 8, 7, 21, 40))
  })

  it('aggregates every stage row that belongs to no imported session into one warning', () => {
    const {warnings} = parseSamsungExport(files())
    const orphanWarnings = warnings.filter(w => w.includes('belong to no imported session'))
    expect(orphanWarnings).toEqual(['1 sleep stage row(s) belong to no imported session — skipped.'])
  })
})

describe('parseSamsungExport: warnings', () => {
  it('warns once each on the bad session row, the stage row missing a start_time, and the unrecognized stage code', () => {
    const {warnings} = parseSamsungExport(files())
    expect(warnings.filter(w => w.includes('sleep session row: missing start_time/end_time'))).toHaveLength(1)
    expect(warnings.filter(w => w.includes('sleep stage row: missing start_time/end_time'))).toHaveLength(1)
    expect(warnings.some(w => w.includes('unrecognized stage code') && w.includes('99999'))).toBe(true)
  })

  it('never throws when no sleep-session file is present', () => {
    const {sessions, warnings} = parseSamsungExport([{name: 'com.samsung.health.sleep_stage.20260907.csv', text: read('samsungSleepStage.csv')}])
    expect(sessions).toEqual([])
    expect(warnings[0]).toContain('No Samsung sleep-session CSV')
  })

  it('matches a column by its bare or dotted-prefixed name the same way', () => {
    const bareHeader = [
      '#metadata',
      'start_time,end_time,time_offset,datauuid',
      '2026-09-07 06:00:00.000,2026-09-07 06:30:00.000,UTC+0000,ssn-bare',
    ].join('\n')
    const dottedHeader = [
      '#metadata',
      'com.samsung.health.sleep.start_time,com.samsung.health.sleep.end_time,com.samsung.health.sleep.time_offset,com.samsung.health.sleep.datauuid',
      '2026-09-07 07:00:00.000,2026-09-07 07:30:00.000,UTC+0000,ssn-dotted',
    ].join('\n')
    const {sessions, warnings} = parseSamsungExport([
      {name: 'com.samsung.shealth.sleep.bare.csv', text: bareHeader},
      {name: 'com.samsung.shealth.sleep.dotted.csv', text: dottedHeader},
    ])
    expect(warnings).toEqual([])
    expect(sessions.map(s => s.externalId).sort()).toEqual(['ssn-bare', 'ssn-dotted'])
  })
})

describe('parseSamsungExport: vitals', () => {
  it('gives every session the same heart-rate samples, one per row at its window midpoint, sorted, skipping the blank-value row with a warning', () => {
    const {sessions, warnings} = parseSamsungExport(files())
    for (const session of sessions) {
      expect(session.heartRate.map(s => s.value)).toEqual([58, 56, 60, 65])
      expect(session.heartRate[0].at.getTime()).toBe(Date.UTC(2026, 8, 7, 9, 0, 30))
      expect(session.heartRate[1].at.getTime()).toBe(Date.UTC(2026, 8, 7, 9, 1, 30))
      expect(session.heartRate[2].at.getTime()).toBe(Date.UTC(2026, 8, 7, 9, 3, 30))
      expect(session.heartRate[3].at.getTime()).toBe(Date.UTC(2026, 8, 7, 21, 10, 30))
    }
    expect(warnings.some(w => w.includes('heart-rate') && w.includes('1 row(s) without a time, value or baseline'))).toBe(true)
  })

  it('reads skin temperature as temperature minus baseline at the window midpoint, skipping a row with no baseline', () => {
    const {sessions, warnings} = parseSamsungExport(files())
    for (const session of sessions) {
      expect(session.skinTemp).toHaveLength(1)
      expect(session.skinTemp[0].value).toBeCloseTo(0.5, 10)
      expect(session.skinTemp[0].at.getTime()).toBe(Date.UTC(2026, 8, 7, 12, 46))
    }
    expect(warnings.some(w => w.includes('skin-temperature') && w.includes('1 row(s) without a time, value or baseline'))).toBe(true)
  })

  it('reads respiratory rate from the bare `average` column at the window midpoint', () => {
    const {sessions} = parseSamsungExport(files())
    for (const session of sessions) {
      expect(session.respRate).toEqual([{at: new Date(Date.UTC(2026, 8, 7, 12, 46)), value: 14.5}])
    }
  })

  it('reads oxygen saturation from the real file only, ignoring the sibling .raw file entirely', () => {
    const {sessions} = parseSamsungExport(files())
    for (const session of sessions) {
      expect(session.spo2).toHaveLength(1)
      expect(session.spo2[0].value).toBe(96.8)
      expect(session.spo2[0].at.getTime()).toBe(Date.UTC(2026, 8, 7, 12, 46))
    }
  })
})

describe('parseSamsungExport: HRV', () => {
  it('reads rmssd from the binning JSON, one sample per entry at start_time, sorted even though the file lists them out of order', () => {
    const {sessions} = parseSamsungExport(files())
    for (const session of sessions) {
      expect(session.hrv).toEqual([
        {at: new Date(1788775200000), value: 28.1},
        {at: new Date(1788786000000), value: 32.5},
      ])
    }
  })

  it('warns to pick the whole export folder when the HRV CSV is present but no HRV JSON is', () => {
    const {sessions, warnings} = parseSamsungExport([minimalSessionFile, {name: 'com.samsung.health.hrv.20260907.csv', text: read('samsungHrv.csv')}])
    expect(sessions[0].hrv).toEqual([])
    expect(warnings.some(w => w.includes('pick the whole export folder'))).toBe(true)
  })

  it('warns and skips a HRV binning file that is not valid JSON', () => {
    const {sessions, warnings} = parseSamsungExport([
      minimalSessionFile,
      {name: 'jsons/com.samsung.health.hrv/9/broken.binning_data.json', text: 'not json'},
    ])
    expect(sessions[0].hrv).toEqual([])
    expect(warnings.some(w => w.includes('broken.binning_data.json') && w.includes('not valid JSON'))).toBe(true)
  })

  it('warns and skips a HRV binning file that is valid JSON but not an array', () => {
    const {sessions, warnings} = parseSamsungExport([
      minimalSessionFile,
      {name: 'jsons/com.samsung.health.hrv/9/notarray.binning_data.json', text: '{"start_time": 1, "rmssd": 2}'},
    ])
    expect(sessions[0].hrv).toEqual([])
    expect(warnings.some(w => w.includes('notarray.binning_data.json') && w.includes('not a JSON array'))).toBe(true)
  })
})

describe('parseSamsungExport: file recognition by exact segment', () => {
  it('does not read a `recovery_heart_rate` file as heart-rate data', () => {
    const recovery = {
      name: 'com.samsung.shealth.tracker.recovery_heart_rate.20260907.csv',
      text: [
        '#com.samsung.health.recovery_heart_rate',
        'com.samsung.health.recovery_heart_rate.start_time,com.samsung.health.recovery_heart_rate.end_time,com.samsung.health.recovery_heart_rate.heart_rate',
        '2026-01-01 00:00:00.000,2026-01-01 00:01:00.000,999',
      ].join('\n'),
    }
    const {sessions} = parseSamsungExport([minimalSessionFile, recovery])
    expect(sessions[0].heartRate).toEqual([])
  })

  it('does not read sleep_snoring, sleep_apnea or sleep_raw_data files as sleep sessions', () => {
    const decoy = (segment: string) => ({
      name: `com.samsung.shealth.${segment}.20260907.csv`,
      text: [
        '#decoy',
        'com.samsung.health.sleep.start_time,com.samsung.health.sleep.end_time,com.samsung.health.sleep.datauuid',
        '2026-01-02 00:00:00.000,2026-01-02 08:00:00.000,ssn-decoy',
      ].join('\n'),
    })
    const {sessions} = parseSamsungExport([
      minimalSessionFile,
      decoy('sleep_snoring'),
      decoy('sleep_apnea'),
      decoy('sleep_raw_data'),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].externalId).toBe('ssn-min')
  })
})

describe('parseSamsungExport: sample ordering', () => {
  it('hands every sample array over time-sorted', () => {
    const {sessions} = parseSamsungExport(files())
    for (const session of sessions) {
      for (const samples of [session.heartRate, session.hrv, session.spo2, session.skinTemp, session.respRate]) {
        for (let i = 1; i < samples.length; i++) {
          expect(samples[i].at.getTime()).toBeGreaterThanOrEqual(samples[i - 1].at.getTime())
        }
      }
      for (let i = 1; i < session.stages.length; i++) {
        expect(session.stages[i].start.getTime()).toBeGreaterThanOrEqual(session.stages[i - 1].start.getTime())
      }
    }
  })
})

describe('detectImport / importSessions (samsung-export)', () => {
  it('detects a file named with the com.samsung. prefix', () => {
    const detection = detectImport([{name: 'com.samsung.shealth.sleep.20260907.csv', text: read('samsungSleep.csv')}])
    expect(detection).toEqual({kind: 'samsung-export'})
  })

  it('importSessions dispatches the whole file set end-to-end', () => {
    const {sessions} = importSessions(files())
    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.source === 'samsung-export')).toBe(true)
  })
})
