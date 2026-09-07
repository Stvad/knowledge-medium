import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {detectImport, importSessions} from '../src/import/index'
import {parseSamsungExport} from '../src/import/samsungExport'

const read = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

const files = () => [
  {name: 'com.samsung.shealth.sleep.20240311.csv', text: read('samsungSleep.csv')},
  {name: 'com.samsung.health.sleep_stage.20240311.csv', text: read('samsungSleepStage.csv')},
  {name: 'com.samsung.shealth.tracker.heart_rate.20240311.csv', text: read('samsungHeartRate.csv')},
]

describe('parseSamsungExport', () => {
  it('reads the two well-formed sessions and skips the one with no start_time', () => {
    const {sessions} = parseSamsungExport(files())
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.externalId).sort()).toEqual(['ssn-main-1', 'ssn-nap-1'])
  })

  it('applies the time_offset to get the real instant, tolerating the header\'s trailing extra field', () => {
    const {sessions} = parseSamsungExport(files())
    const main = sessions.find(s => s.externalId === 'ssn-main-1')!
    expect(main.source).toBe('samsung-export')
    expect(main.start.getTime()).toBe(new Date('2024-03-11T06:41:00.000Z').getTime())
    expect(main.end.getTime()).toBe(new Date('2024-03-11T14:12:00.000Z').getTime())
  })

  it('reads stated efficiency (as a 0–1 fraction), score and sleep minutes off the main session row', () => {
    const {sessions} = parseSamsungExport(files())
    const main = sessions.find(s => s.externalId === 'ssn-main-1')!
    expect(main.stated).toEqual({efficiency: 0.92, score: 78, sleepMinutes: 451})
  })

  it('omits stated fields the row left blank, keeping only what it stated', () => {
    const {sessions} = parseSamsungExport(files())
    const nap = sessions.find(s => s.externalId === 'ssn-nap-1')!
    expect(nap.start.getTime()).toBe(new Date('2024-03-11T21:05:00.000Z').getTime())
    expect(nap.end.getTime()).toBe(new Date('2024-03-11T21:35:00.000Z').getTime())
    expect(nap.stated).toEqual({sleepMinutes: 30})
  })

  it('joins stages to the main session by sleep_id, sorted by start, mapping stage codes and keeping an unrecognized one as \'unknown\'', () => {
    const {sessions} = parseSamsungExport(files())
    const main = sessions.find(s => s.externalId === 'ssn-main-1')!
    expect(main.stages.map(s => s.kind)).toEqual(['awake', 'light', 'deep', 'rem', 'unknown'])
    expect(main.stages[0].start.getTime()).toBe(new Date('2024-03-11T06:41:00.000Z').getTime())
    expect(main.stages[0].end.getTime()).toBe(new Date('2024-03-11T06:50:00.000Z').getTime())
    expect(main.stages.at(-1)!.end.getTime()).toBe(new Date('2024-03-11T14:12:00.000Z').getTime())
  })

  it('falls back to interval containment for a stage row with no sleep_id', () => {
    const {sessions} = parseSamsungExport(files())
    const nap = sessions.find(s => s.externalId === 'ssn-nap-1')!
    expect(nap.stages).toHaveLength(1)
    expect(nap.stages[0].kind).toBe('light')
    expect(nap.stages[0].start.getTime()).toBe(new Date('2024-03-11T21:05:00.000Z').getTime())
  })

  it('gives every session the whole export\'s vitals, unfiltered by the session window', () => {
    const {sessions} = parseSamsungExport(files())
    for (const session of sessions) {
      expect(session.heartRate.map(s => s.value)).toEqual([58, 52])
      expect(session.heartRate[0].at.getTime()).toBe(new Date('2024-03-11T07:00:00.000Z').getTime())
      expect(session.heartRate[1].at.getTime()).toBe(new Date('2024-03-11T09:00:00.000Z').getTime())
    }
  })

  it('warns on a dangling sleep_id, a stage row missing its start_time, a bad session row, and the empty heart-rate value — and nothing else', () => {
    const {warnings} = parseSamsungExport(files())
    expect(warnings.some(w => w.includes('ssn-ghost') && w.includes('does not match'))).toBe(true)
    expect(warnings.some(w => w.includes('sleep stage row: missing start_time/end_time'))).toBe(true)
    expect(warnings.some(w => w.includes('sleep session row: missing start_time/end_time'))).toBe(true)
    expect(warnings.some(w => w.includes('heart-rate') && w.includes('missing time or value'))).toBe(true)
    expect(warnings.some(w => w.includes('unrecognized stage code') && w.includes('99999'))).toBe(true)
    expect(warnings).toHaveLength(5)
  })

  it('never throws when no sleep-session file is present', () => {
    const {sessions, warnings} = parseSamsungExport([{name: 'com.samsung.health.sleep_stage.20240311.csv', text: read('samsungSleepStage.csv')}])
    expect(sessions).toEqual([])
    expect(warnings[0]).toContain('No Samsung sleep-session CSV')
  })

  it('matches a column by its bare or dotted-prefixed name the same way', () => {
    const bareHeader = [
      '#metadata',
      'start_time,end_time,time_offset,datauuid',
      '2024-03-11 06:00:00.000,2024-03-11 06:30:00.000,UTC+0000,ssn-bare',
    ].join('\n')
    const dottedHeader = [
      '#metadata',
      'com.samsung.health.sleep.start_time,com.samsung.health.sleep.end_time,com.samsung.health.sleep.time_offset,com.samsung.health.sleep.datauuid',
      '2024-03-11 07:00:00.000,2024-03-11 07:30:00.000,UTC+0000,ssn-dotted',
    ].join('\n')
    const {sessions, warnings} = parseSamsungExport([
      {name: 'com.samsung.shealth.sleep.bare.csv', text: bareHeader},
      {name: 'com.samsung.shealth.sleep.dotted.csv', text: dottedHeader},
    ])
    expect(warnings).toEqual([])
    expect(sessions.map(s => s.externalId).sort()).toEqual(['ssn-bare', 'ssn-dotted'])
  })
})

describe('detectImport / importSessions (samsung-export)', () => {
  it('detects a file named with the com.samsung. prefix', () => {
    const detection = detectImport([{name: 'com.samsung.shealth.sleep.20240311.csv', text: read('samsungSleep.csv')}])
    expect(detection).toEqual({kind: 'samsung-export'})
  })

  it('importSessions dispatches the whole file set end-to-end', () => {
    const {sessions} = importSessions(files())
    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.source === 'samsung-export')).toBe(true)
  })
})
