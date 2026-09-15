import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {detectImport, importSessions} from '../src/import/index'
import {parseHealthConnectPayload} from '../src/import/healthConnect'

const fixture = () => JSON.parse(readFileSync(join(__dirname, 'fixtures/healthConnectPayload.json'), 'utf8')) as unknown
const fixtureText = () => readFileSync(join(__dirname, 'fixtures/healthConnectPayload.json'), 'utf8')

describe('parseHealthConnectPayload', () => {
  it('reads both sleep sessions', () => {
    const {sessions} = parseHealthConnectPayload(fixture())
    expect(sessions).toHaveLength(2)
  })

  it('derives the main session\'s start from session_end_time − duration_seconds, and reads its externalId from metadata.id', () => {
    const {sessions} = parseHealthConnectPayload(fixture())
    const main = sessions[0]
    expect(main.source).toBe('health-connect')
    expect(main.externalId).toBe('hc-sleep-main-1')
    expect(main.start.getTime()).toBe(new Date('2024-03-10T23:41:00.000Z').getTime())
    expect(main.end.getTime()).toBe(new Date('2024-03-11T07:12:00.000Z').getTime())
  })

  it('maps every stage kind, sorted by start, and recovers an unrecognized stage as \'unknown\' rather than dropping it', () => {
    const {sessions} = parseHealthConnectPayload(fixture())
    const main = sessions[0]
    expect(main.stages.map(s => s.kind)).toEqual(['awake', 'light', 'deep', 'rem', 'unknown', 'sleeping'])
    // sorted by start
    for (let i = 1; i < main.stages.length; i++) {
      expect(main.stages[i].start.getTime()).toBeGreaterThanOrEqual(main.stages[i - 1].start.getTime())
    }
    expect(main.stages[0].start.getTime()).toBe(new Date('2024-03-10T23:41:00.000Z').getTime())
    expect(main.stages[0].end.getTime()).toBe(new Date('2024-03-10T23:50:00.000Z').getTime())
  })

  it('reads the nap\'s explicit start/end and externalId from `uid`, and maps a numeric stage code', () => {
    const {sessions} = parseHealthConnectPayload(fixture())
    const nap = sessions[1]
    expect(nap.externalId).toBe('hc-sleep-nap-1')
    expect(nap.start.getTime()).toBe(new Date('2024-03-11T14:05:00.000Z').getTime())
    expect(nap.end.getTime()).toBe(new Date('2024-03-11T14:35:00.000Z').getTime())
    expect(nap.stages).toEqual([{kind: 'light', start: new Date('2024-03-11T14:05:00.000Z'), end: new Date('2024-03-11T14:35:00.000Z')}])
  })

  it('gives every session the whole payload\'s vitals, unfiltered by the session window', () => {
    const {sessions} = parseHealthConnectPayload(fixture())
    for (const session of sessions) {
      expect(session.heartRate.map(s => s.value)).toEqual([58, 52, 61])
      expect(session.hrv.map(s => s.value)).toEqual([45.2, 51.8])
      expect(session.spo2.map(s => s.value)).toEqual([96.5, 95.0])
      expect(session.skinTemp.map(s => s.value)).toEqual([0.3, 0.6])
      expect(session.respRate.map(s => s.value)).toEqual([14.2, 13.8])
    }
  })

  it('warns on (and skips) a malformed heart_rate sample, and warns on (but keeps) the unrecognized stage', () => {
    const {warnings} = parseHealthConnectPayload(fixture())
    expect(warnings).toHaveLength(2)
    expect(warnings.some(w => w.includes('heart_rate') && w.includes('skipped'))).toBe(true)
    expect(warnings.some(w => w.includes('bogus-stage-code') && w.includes('unknown'))).toBe(true)
  })

  it('never throws on a non-object payload, and says why nothing was read', () => {
    expect(parseHealthConnectPayload(null)).toEqual({sessions: [], warnings: ['Health Connect payload is not a JSON object.']})
    expect(parseHealthConnectPayload('not json').sessions).toEqual([])
    expect(parseHealthConnectPayload(42).sessions).toEqual([])
  })

  it('skips a non-object sleep entry with a warning instead of throwing', () => {
    const {sessions, warnings} = parseHealthConnectPayload({sleep: [42]})
    expect(sessions).toEqual([])
    expect(warnings).toEqual(['sleep session 0: not an object — skipped.'])
  })

  it('skips a sleep entry with no way to determine start/end', () => {
    const {sessions, warnings} = parseHealthConnectPayload({sleep: [{stages: []}]})
    expect(sessions).toEqual([])
    expect(warnings[0]).toContain('could not determine start/end time')
  })

  it('hands back every sample array time-sorted, even when the payload lists them out of order', () => {
    const payload = {
      sleep: [{start_time: '2024-03-11T00:00:00.000Z', end_time: '2024-03-11T08:00:00.000Z', stages: []}],
      heart_rate: [
        {bpm: 61, time: '2024-03-11T06:00:00.000Z'},
        {bpm: 58, time: '2024-03-11T01:00:00.000Z'},
        {bpm: 52, time: '2024-03-11T03:00:00.000Z'},
      ],
    }
    const {sessions} = parseHealthConnectPayload(payload)
    expect(sessions[0].heartRate.map(s => s.value)).toEqual([58, 52, 61])
    for (let i = 1; i < sessions[0].heartRate.length; i++) {
      expect(sessions[0].heartRate[i].at.getTime()).toBeGreaterThanOrEqual(sessions[0].heartRate[i - 1].at.getTime())
    }
  })
})

describe('detectImport / importSessions (health-connect)', () => {
  it('detects a single JSON file as a health-connect payload', () => {
    const detection = detectImport([{name: 'payload.json', text: fixtureText()}])
    expect(detection.kind).toBe('health-connect')
  })

  it('detects pasted text starting with "{" even without a .json name', () => {
    const detection = detectImport([{name: 'pasted', text: fixtureText()}])
    expect(detection.kind).toBe('health-connect')
  })

  it('reports a parse failure instead of throwing', () => {
    const detection = detectImport([{name: 'payload.json', text: '{not valid json'}])
    expect(detection).toEqual({kind: 'unknown', reason: expect.stringContaining('failed to parse')})
  })

  it('importSessions dispatches a JSON file end-to-end', () => {
    const {sessions} = importSessions([{name: 'payload.json', text: fixtureText()}])
    expect(sessions).toHaveLength(2)
    expect(sessions[0].source).toBe('health-connect')
  })
})
