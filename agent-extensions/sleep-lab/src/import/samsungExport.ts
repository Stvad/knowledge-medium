/** Samsung Health "Download personal data" export importer.
 *
 *  Fitted against a real export (Samsung Health 7.x, Galaxy Watch 8,
 *  2026-09). What it contains, and what this reads:
 *
 *   - `com.samsung.shealth.sleep.<ts>.csv` — one row per sleep session.
 *     Columns are dotted-prefixed (`com.samsung.health.sleep.start_time`)
 *     or bare (`efficiency`, `sleep_score`, `sleep_latency` in ms,
 *     `total_rem_duration` / `total_light_duration` in minutes,
 *     `sleep_duration` in minutes); this file matches by the suffix after
 *     the last `.`.
 *   - `com.samsung.health.sleep_stage.<ts>.csv` — one row per stage segment,
 *     `sleep_id` = the session's `datauuid`, `stage` 40001–40004.
 *   - `com.samsung.shealth.tracker.heart_rate.<ts>.csv` — ~1/min rows.
 *   - `com.samsung.shealth.tracker.oxygen_saturation.<ts>.csv`,
 *     `com.samsung.health.skin_temperature.<ts>.csv`,
 *     `com.samsung.health.respiratory_rate.<ts>.csv` — one row per NIGHT,
 *     spanning the sleep, with the night's mean (`spo2`, `temperature` +
 *     `baseline`, `average`). Read as one sample at the window's midpoint.
 *   - `com.samsung.health.hrv.<ts>.csv` carries NO value: RMSSD lives only
 *     in the per-row binning files under `jsons/com.samsung.health.hrv/`,
 *     `[{start_time, end_time, sdnn, rmssd}]` with epoch-ms times. Pick the
 *     export FOLDER (not just the CSVs) to get HRV.
 *
 *  Every file's first line is exporter metadata; the header is line 2; a
 *  data row may carry one more (empty) trailing field than the header.
 *
 *  Timestamps (`2026-09-07 08:59:00.000`) are UTC. The `time_offset` column
 *  (`UTC-0700`) says which zone the user was in and is NOT applied to the
 *  instant — the local calendar day is the reader's business (`day.ts`).
 */

import type {ImportedSession, Sample, SessionMeasure, Stage, StageKind} from '../engine/types'
import {rowsWithHeader} from './csv'

export interface SamsungFile {
  /** The path inside the export when a folder was picked, else the bare
   *  file name — either way the `com.samsung.…` segments are what is read. */
  name: string
  text: string
}

// ──── field access on a header-mapped CSV row ────

/** Collapse every column name down to its suffix after the last `.`, so
 *  `com.samsung.health.sleep.start_time` and a bare `start_time` read the
 *  same way. */
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

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/

/** A Samsung timestamp string, which is UTC. */
export const parseSamsungInstant = (raw: string | undefined): Date | undefined => {
  if (raw === undefined) return undefined
  const m = WALL_CLOCK.exec(raw.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s, ms] = m
  return new Date(Date.UTC(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
    ms ? Number(ms.padEnd(3, '0')) : 0,
  ))
}

const midpoint = (start: Date, end: Date | undefined): Date =>
  end === undefined || end <= start ? start : new Date((start.getTime() + end.getTime()) / 2)

// ──── stage codes ────

const STAGE_CODE: Record<string, StageKind> = {
  '40001': 'awake',
  '40002': 'light',
  '40003': 'deep',
  '40004': 'rem',
}

// ──── file recognition ────
// By exact dotted SEGMENT, not substring: `recovery_heart_rate`,
// `sleep_snoring`, `sleep_apnea` and `oxygen_saturation.raw` all sit beside
// the files wanted here and must not be read as them.

const segments = (name: string): string[] => name.split(/[./\\]/)
const has = (name: string, segment: string): boolean => segments(name).includes(segment)
const isCsv = (name: string): boolean => name.toLowerCase().endsWith('.csv')
const isJson = (name: string): boolean => name.toLowerCase().endsWith('.json')

const isSleepSessionFile = (name: string): boolean => isCsv(name) && has(name, 'sleep')
const isSleepStageFile = (name: string): boolean => isCsv(name) && has(name, 'sleep_stage')
const isHeartRateFile = (name: string): boolean => isCsv(name) && has(name, 'heart_rate')
const isOxygenFile = (name: string): boolean => isCsv(name) && has(name, 'oxygen_saturation') && !has(name, 'raw')
const isSkinTempFile = (name: string): boolean => isCsv(name) && has(name, 'skin_temperature')
const isRespRateFile = (name: string): boolean => isCsv(name) && has(name, 'respiratory_rate')
const isHrvCsv = (name: string): boolean => isCsv(name) && has(name, 'hrv')
const isHrvJson = (name: string): boolean => isJson(name) && has(name, 'hrv')

/** Whether a path inside the export is one this importer reads at all —
 *  so a caller can skip reading the rest (a full export is thousands of
 *  files, most of them per-minute JSON for series this never opens). */
export const isSamsungFileOfInterest = (name: string): boolean =>
  isSleepSessionFile(name) || isSleepStageFile(name) || isHeartRateFile(name) || isOxygenFile(name)
  || isSkinTempFile(name) || isRespRateFile(name) || isHrvCsv(name) || isHrvJson(name)

const rowsOf = (files: SamsungFile[]): Record<string, string>[] =>
  files.flatMap(f => rowsWithHeader(f.text, {skipFirstLine: true}).rows.map(normalizeRow))

// ──── vitals ────

interface VitalSpec {
  label: string
  /** Column candidates for the value, first present wins. */
  valueKeys: string[]
  /** Subtracted from the value when present — skin temperature is stored
   *  absolute with the watch's own baseline beside it, and the measure the
   *  protocol compares is the delta. A row with no baseline is skipped. */
  baselineKey?: string
}

/** Every readable row across every matching file becomes one sample at the
 *  midpoint of its window — same "whole export's samples on every session"
 *  contract the Health Connect path uses (`ImportedSession`). */
const parseVitalFiles = (files: SamsungFile[], spec: VitalSpec, warnings: string[]): Sample[] => {
  const samples: Sample[] = []
  for (const file of files) {
    const {rows} = rowsWithHeader(file.text, {skipFirstLine: true})
    if (rows.length === 0) {
      warnings.push(`${spec.label} file "${file.name}" has no data rows — skipped.`)
      continue
    }
    let skipped = 0
    for (const raw of rows) {
      const row = normalizeRow(raw)
      const start = parseSamsungInstant(str(row, 'start_time'))
      const value = num(row, ...spec.valueKeys)
      const baseline = spec.baselineKey === undefined ? 0 : num(row, spec.baselineKey)
      if (!start || value === undefined || baseline === undefined) {
        skipped += 1
        continue
      }
      samples.push({at: midpoint(start, parseSamsungInstant(str(row, 'end_time'))), value: value - baseline})
    }
    if (skipped > 0) warnings.push(`${spec.label} file "${file.name}": ${skipped} row(s) without a time, value or baseline — skipped.`)
  }
  return samples
}

/** RMSSD from the HRV binning files: a JSON array of windows with epoch-ms
 *  times. Each window is one sample at its start. */
const parseHrvJsonFiles = (files: SamsungFile[], warnings: string[]): Sample[] => {
  const samples: Sample[] = []
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(file.text)
    } catch {
      warnings.push(`hrv file "${file.name}" is not valid JSON — skipped.`)
      continue
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`hrv file "${file.name}" is not a JSON array — skipped.`)
      continue
    }
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const {start_time, rmssd} = entry as Record<string, unknown>
      if (typeof start_time !== 'number' || typeof rmssd !== 'number' || !Number.isFinite(rmssd)) continue
      samples.push({at: new Date(start_time), value: rmssd})
    }
  }
  return samples
}

// ──── sessions and stages ────

interface RawSession {
  id?: string
  start: Date
  end: Date
  stated: Partial<Record<SessionMeasure, number>>
}

const parseSessionRow = (row: Record<string, string>, warnings: string[]): RawSession | undefined => {
  const start = parseSamsungInstant(str(row, 'start_time'))
  const end = parseSamsungInstant(str(row, 'end_time'))
  if (!start || !end) {
    warnings.push('sleep session row: missing start_time/end_time — skipped.')
    return undefined
  }
  // Samsung's own numbers, used by the derivation only where the stages
  // cannot answer (`deriveMeasures`); the score has no other source.
  const stated: Partial<Record<SessionMeasure, number>> = {}
  const score = num(row, 'sleep_score')
  if (score !== undefined) stated.score = score
  // Percent here, 0–1 in the engine (FIELD.efficiency).
  const efficiencyPct = num(row, 'efficiency')
  if (efficiencyPct !== undefined) stated.efficiency = efficiencyPct / 100
  // `sleep_duration` is the whole in-bed span (it equals end − start on
  // every real row), not the time asleep — so it states `inBedMinutes`.
  const durationMin = num(row, 'sleep_duration')
  if (durationMin !== undefined) stated.inBedMinutes = durationMin
  // Milliseconds in the export.
  const latencyMs = num(row, 'sleep_latency')
  if (latencyMs !== undefined && latencyMs >= 0) stated.onsetMinutes = Math.round(latencyMs / 60_000 * 10) / 10
  const rem = num(row, 'total_rem_duration')
  if (rem !== undefined) stated.remMinutes = rem
  const light = num(row, 'total_light_duration')
  if (light !== undefined) stated.lightMinutes = light
  return {id: str(row, 'datauuid'), start, end, stated}
}

interface RawStage {
  stage: Stage
  sleepId?: string
}

const parseStageRow = (row: Record<string, string>, warnings: string[]): RawStage | undefined => {
  const start = parseSamsungInstant(str(row, 'start_time'))
  const end = parseSamsungInstant(str(row, 'end_time'))
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

  const parsedStages = rowsOf(files.filter(f => isSleepStageFile(f.name)))
    .map(row => parseStageRow(row, warnings))
    .filter((s): s is RawStage => s !== undefined)

  const stagesFor = new Map<RawSession, Stage[]>(parsedSessions.map(s => [s, []]))
  const sessionById = new Map(parsedSessions.filter((s): s is RawSession & {id: string} => s.id !== undefined).map(s => [s.id, s]))
  let orphanStages = 0
  for (const {stage, sleepId} of parsedStages) {
    const owner = sleepId !== undefined
      ? sessionById.get(sleepId)
      // No sleep_id on this row: fall back to interval containment.
      : parsedSessions.find(s => stage.start >= s.start && stage.end <= s.end)
    if (owner) stagesFor.get(owner)!.push(stage)
    else orphanStages += 1
  }
  if (orphanStages > 0) warnings.push(`${orphanStages} sleep stage row(s) belong to no imported session — skipped.`)

  const heartRate = parseVitalFiles(files.filter(f => isHeartRateFile(f.name)), {label: 'heart-rate', valueKeys: ['heart_rate', 'bpm']}, warnings)
  const spo2 = parseVitalFiles(files.filter(f => isOxygenFile(f.name)), {label: 'oxygen-saturation', valueKeys: ['spo2', 'percentage']}, warnings)
  const skinTemp = parseVitalFiles(files.filter(f => isSkinTempFile(f.name)), {label: 'skin-temperature', valueKeys: ['temperature'], baselineKey: 'baseline'}, warnings)
  const respRate = parseVitalFiles(files.filter(f => isRespRateFile(f.name)), {label: 'respiratory-rate', valueKeys: ['average', 'respiratory_rate', 'rate']}, warnings)
  const hrvJson = files.filter(f => isHrvJson(f.name))
  const hrv = parseHrvJsonFiles(hrvJson, warnings)
  if (hrvJson.length === 0 && files.some(f => isHrvCsv(f.name))) {
    warnings.push('The HRV CSV carries no values — pick the whole export folder so its jsons/com.samsung.health.hrv files come along.')
  }

  const byTime = (a: Sample, b: Sample): number => a.at.getTime() - b.at.getTime()
  for (const samples of [heartRate, spo2, skinTemp, respRate, hrv]) samples.sort(byTime)

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
