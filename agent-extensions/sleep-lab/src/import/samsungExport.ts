/** Samsung Health "Download personal data" export importer.
 *
 *  The column layout below comes from public write-ups of Samsung Health's
 *  CSV export, **not from a real export** — fit this against one before
 *  trusting a number from this path (see the README).
 *
 *  Known shape: files are named like
 *  `com.samsung.shealth.sleep.<timestamp>.csv` (one row per sleep session)
 *  and `com.samsung.health.sleep_stage.<timestamp>.csv` (one row per stage
 *  segment). The first line of every such file is exporter metadata, not
 *  data — the real header is line 2 — and a data row may carry one more
 *  (empty) trailing field than the header declares. Column names appear
 *  either bare (`start_time`) or dotted-prefixed
 *  (`com.samsung.health.sleep.start_time`); this file matches by the suffix
 *  after the last `.`, so either spelling works.
 *
 *  Timestamps are naive local strings (`2024-03-10 06:41:00.000`) plus a
 *  separate `time_offset` column (`UTC-0700`, `UTC+0900`) giving the offset
 *  the string was written in — the true instant is the wall-clock value
 *  reinterpreted at that offset (ISO sense: UTC = local − offset), not the
 *  wall-clock value taken as UTC.
 */

import type {ImportedSession, Sample, SessionMeasure, Stage, StageKind} from '../engine/types'
import {rowsWithHeader} from './csv'

export interface SamsungFile {
  name: string
  text: string
}

// ──── field access on a header-mapped CSV row ────

/** Collapse every column name in a row down to its suffix after the last
 *  `.`, so `com.samsung.health.sleep.start_time` and a bare `start_time`
 *  read the same way. */
const normalizeRow = (row: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    const shortKey = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key
    out[shortKey] = value
  }
  return out
}

const str = (row: Record<string, string>, key: string): string | undefined => {
  const v = row[key]
  return v !== undefined && v.trim() !== '' ? v : undefined
}

const num = (row: Record<string, string>, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const v = row[key]
    if (v === undefined || v.trim() === '') continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

// ──── timestamps ────

/** `UTC-0700` / `UTC+0900` → signed offset minutes, ISO sense (UTC = local −
 *  offset). */
const parseOffsetMinutes = (raw: string | undefined): number => {
  const m = raw !== undefined ? /^UTC([+-])(\d{2})(\d{2})$/.exec(raw.trim()) : null
  if (!m) return 0
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/

const parseSamsungInstant = (raw: string | undefined, offsetRaw: string | undefined): Date | undefined => {
  if (raw === undefined) return undefined
  const m = WALL_CLOCK.exec(raw.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s, ms] = m
  const wallAsUtcMs = Date.UTC(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
    ms ? Number(ms.padEnd(3, '0')) : 0,
  )
  return new Date(wallAsUtcMs - parseOffsetMinutes(offsetRaw) * 60_000)
}

// ──── stage codes ────

const STAGE_CODE: Record<string, StageKind> = {
  '40001': 'awake',
  '40002': 'light',
  '40003': 'deep',
  '40004': 'rem',
}

// ──── file recognition ────

const segments = (name: string): string[] => name.split('.')
const isSleepStageFile = (name: string): boolean => segments(name).includes('sleep_stage')
const isSleepSessionFile = (name: string): boolean => !isSleepStageFile(name) && segments(name).includes('sleep')
const isHeartRateFile = (name: string): boolean => name.includes('heart_rate') && !isSleepStageFile(name)
const isOxygenFile = (name: string): boolean => name.includes('oxygen_saturation')
const isHrvFile = (name: string): boolean => segments(name).includes('hrv')
const isSkinTempFile = (name: string): boolean => name.includes('skin_temperature')
const isRespRateFile = (name: string): boolean => name.includes('respiratory_rate')

const rowsOf = (files: SamsungFile[]): Record<string, string>[] =>
  files.flatMap(f => rowsWithHeader(f.text, {skipFirstLine: true}).rows.map(normalizeRow))

/** A recognized vitals file, read tolerantly: `start_time` (falling back to
 *  `time`) + one of `valueKeys`. Every readable row across every matching
 *  file becomes one sample — same "whole export's samples on every session"
 *  contract the Health Connect path uses (see `ImportedSession` in
 *  engine/types.ts). */
const parseVitalFiles = (files: SamsungFile[], valueKeys: string[], label: string, warnings: string[]): Sample[] => {
  const samples: Sample[] = []
  for (const file of files) {
    const {rows} = rowsWithHeader(file.text, {skipFirstLine: true})
    if (rows.length === 0) {
      warnings.push(`${label} file "${file.name}" has no data rows — skipped.`)
      continue
    }
    rows.map(normalizeRow).forEach((row, i) => {
      const offset = str(row, 'time_offset')
      const at = parseSamsungInstant(str(row, 'start_time'), offset) ?? parseSamsungInstant(str(row, 'time'), offset)
      const value = num(row, ...valueKeys)
      if (!at || value === undefined) {
        warnings.push(`${label} file "${file.name}" row ${i}: missing time or value — skipped.`)
        return
      }
      samples.push({at, value})
    })
  }
  return samples
}

interface RawSession {
  id?: string
  start: Date
  end: Date
  stated: Partial<Record<SessionMeasure, number>>
}

const parseSessionRow = (row: Record<string, string>, warnings: string[]): RawSession | undefined => {
  const offset = str(row, 'time_offset')
  const start = parseSamsungInstant(str(row, 'start_time'), offset)
  const end = parseSamsungInstant(str(row, 'end_time'), offset)
  if (!start || !end) {
    warnings.push('sleep session row: missing start_time/end_time — skipped.')
    return undefined
  }
  const stated: Partial<Record<SessionMeasure, number>> = {}
  const score = num(row, 'sleep_score')
  if (score !== undefined) stated.score = score
  // Samsung states efficiency as a percent; the engine's `efficiency` is 0–1
  // (see FIELD.efficiency in km/fields.ts).
  const efficiencyPct = num(row, 'efficiency')
  if (efficiencyPct !== undefined) stated.efficiency = efficiencyPct / 100
  const durationMin = num(row, 'sleep_duration')
  if (durationMin !== undefined) stated.sleepMinutes = durationMin
  return {id: str(row, 'datauuid'), start, end, stated}
}

interface RawStage {
  stage: Stage
  sleepId?: string
}

const parseStageRow = (row: Record<string, string>, warnings: string[]): RawStage | undefined => {
  const offset = str(row, 'time_offset')
  const start = parseSamsungInstant(str(row, 'start_time'), offset)
  const end = parseSamsungInstant(str(row, 'end_time'), offset)
  if (!start || !end) {
    warnings.push('sleep stage row: missing start_time/end_time — skipped.')
    return undefined
  }
  const code = str(row, 'stage')
  const kind = code !== undefined ? STAGE_CODE[code.trim()] : undefined
  if (kind === undefined) {
    warnings.push(`sleep stage row: unrecognized stage code ${JSON.stringify(code)} — recorded as 'unknown'.`)
  }
  return {stage: {kind: kind ?? 'unknown', start, end}, sleepId: str(row, 'sleep_id')}
}

export const parseSamsungExport = (files: SamsungFile[]): {sessions: ImportedSession[]; warnings: string[]} => {
  const warnings: string[] = []

  const sessionFiles = files.filter(f => isSleepSessionFile(f.name))
  if (sessionFiles.length === 0) {
    warnings.push('No Samsung sleep-session CSV (a file named like "com.samsung.shealth.sleep.<timestamp>.csv") was given.')
    return {sessions: [], warnings}
  }

  const parsedSessions = rowsOf(sessionFiles)
    .map(row => parseSessionRow(row, warnings))
    .filter((s): s is RawSession => s !== undefined)

  const stageFiles = files.filter(f => isSleepStageFile(f.name))
  const parsedStages = rowsOf(stageFiles)
    .map(row => parseStageRow(row, warnings))
    .filter((s): s is RawStage => s !== undefined)

  const stagesFor = new Map<RawSession, Stage[]>(parsedSessions.map(s => [s, []]))
  const sessionById = new Map(parsedSessions.filter((s): s is RawSession & {id: string} => s.id !== undefined).map(s => [s.id, s]))
  for (const {stage, sleepId} of parsedStages) {
    if (sleepId !== undefined) {
      const owner = sessionById.get(sleepId)
      if (owner) {
        stagesFor.get(owner)!.push(stage)
      } else {
        warnings.push(`sleep stage row: sleep_id "${sleepId}" does not match any imported sleep session — skipped.`)
      }
      continue
    }
    // No sleep_id on this row: fall back to interval containment.
    const owner = parsedSessions.find(s => stage.start >= s.start && stage.end <= s.end)
    if (owner) {
      stagesFor.get(owner)!.push(stage)
    } else {
      warnings.push(
        `sleep stage row ${stage.start.toISOString()}–${stage.end.toISOString()}: `
        + 'no sleep_id and no enclosing sleep session — skipped.',
      )
    }
  }

  const heartRate = parseVitalFiles(files.filter(f => isHeartRateFile(f.name)), ['heart_rate', 'bpm'], 'heart-rate', warnings)
  const spo2 = parseVitalFiles(files.filter(f => isOxygenFile(f.name)), ['spo2', 'percentage'], 'oxygen-saturation', warnings)
  const hrv = parseVitalFiles(files.filter(f => isHrvFile(f.name)), ['rmssd', 'value'], 'hrv', warnings)
  const skinTemp = parseVitalFiles(files.filter(f => isSkinTempFile(f.name)), ['delta', 'temperature'], 'skin-temperature', warnings)
  const respRate = parseVitalFiles(files.filter(f => isRespRateFile(f.name)), ['respiratory_rate', 'rate', 'value'], 'respiratory-rate', warnings)

  const sessions: ImportedSession[] = parsedSessions.map(session => ({
    source: 'samsung-export',
    externalId: session.id,
    start: session.start,
    end: session.end,
    stages: (stagesFor.get(session) ?? []).slice().sort((a, b) => a.start.getTime() - b.start.getTime()),
    heartRate,
    hrv,
    spo2,
    skinTemp,
    respRate,
    stated: Object.keys(session.stated).length > 0 ? session.stated : undefined,
  }))

  return {sessions, warnings}
}
