/** Health Connect Webhook payload importer
 *  (https://github.com/mcnaveen/health-connect-webhook).
 *
 *  Field names below are read from that repo's `docs/webhook.md` and
 *  `proto/hcwebhook/v1/health_payload.proto` (fetched 2026-09-07 from
 *  `main`) — not from a real payload capture. Confirmed from those sources:
 *
 *  - The root object carries `timestamp` (build time, not a record time) and
 *    `app_version`, plus one snake_case array per data type; a type with no
 *    records in the sync window has its key **omitted entirely**, never an
 *    empty array.
 *  - `sleep` entries carry `session_end_time` + `duration_seconds` +
 *    `stages` — there is **no `session_start_time` field**. This file
 *    derives the session start as `session_end_time − duration_seconds`,
 *    and only falls back to that when neither `start_time` nor
 *    `session_start_time` is present (kept as a tolerant fallback in case a
 *    future or non-stock build adds one).
 *  - Stage objects carry `stage` (string, "Health Connect / AndroidX enum
 *    `toString()`" — the exact spelling isn't given, so this file matches
 *    case-insensitively against the known AndroidX stage names and also
 *    accepts the numeric 0–7 `SleepSessionRecord` stage-type codes),
 *    `start_time`, `end_time`.
 *  - `heart_rate` is `{bpm, time}`; `heart_rate_variability` is
 *    `{rmssd_millis, time}`; `oxygen_saturation` is `{percentage, time}`;
 *    `skin_temperature` is `{time, delta_celsius, baseline_celsius?,
 *    measurement_location}`; `respiratory_rate` is `{rate, time}`. Each is
 *    confirmed to be a **flat** list — "the app emits one JSON object per
 *    sample" — so no nested `samples`/`deltas` wrapper is supported; none
 *    was ever documented.
 *  - None of the documented JSON record shapes carries a per-record id (the
 *    protobuf `RecordMetadata.id` exists only for the gRPC delivery path).
 *    `externalId` below reads `metadata.id`/`uid`/`id` tolerantly, as a
 *    guess for a build that does carry one — not a confirmed field.
 *
 *  Every accessor here is tolerant: an unreadable record produces a warning
 *  and is skipped (or, for an unrecognized stage value only, kept as
 *  `'unknown'` rather than dropped, so the sleep time it covers isn't
 *  silently lost) — this file never throws on a malformed payload.
 */

import type {ImportedSession, Sample, Stage, StageKind} from '../engine/types'

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const parseInstant = (value: unknown): Date | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  return undefined
}

const instantAt = (rec: Record<string, unknown> | undefined, ...keys: string[]): Date | undefined => {
  for (const key of keys) {
    const d = parseInstant(rec?.[key])
    if (d) return d
  }
  return undefined
}

const numAt = (rec: Record<string, unknown> | undefined, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const v = rec?.[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

const strAt = (rec: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const v = rec?.[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

const externalIdOf = (rec: Record<string, unknown>): string | undefined =>
  strAt(asRecord(rec.metadata), 'id') ?? strAt(rec, 'uid', 'id')

// Android `SleepSessionRecord.STAGE_TYPE_*` codes (confirmed constants; the
// JSON string spelling that maps to each is not).
const STAGE_NUMERIC: Record<string, StageKind> = {
  '0': 'unknown',
  '1': 'awake',
  '2': 'sleeping',
  '3': 'out-of-bed',
  '4': 'light',
  '5': 'deep',
  '6': 'rem',
  '7': 'awake', // AWAKE_IN_BED — the engine has no separate kind for it.
}

// Longest/most-specific name first: "AWAKE_IN_BED" and "OUT_OF_BED" must not
// be caught by the bare "AWAKE" pattern.
const STAGE_NAME_ORDER: ReadonlyArray<readonly [RegExp, StageKind]> = [
  [/AWAKE_IN_BED/, 'awake'],
  [/OUT_OF_BED/, 'out-of-bed'],
  [/AWAKE/, 'awake'],
  [/LIGHT/, 'light'],
  [/DEEP/, 'deep'],
  [/REM/, 'rem'],
  [/SLEEPING/, 'sleeping'],
  [/UNKNOWN/, 'unknown'],
]

const stageKindOf = (raw: unknown): StageKind | undefined => {
  if (typeof raw === 'number') return STAGE_NUMERIC[String(Math.trunc(raw))]
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (/^\d+$/.test(trimmed)) return STAGE_NUMERIC[trimmed]
    const upper = trimmed.toUpperCase()
    for (const [pattern, kind] of STAGE_NAME_ORDER) {
      if (pattern.test(upper)) return kind
    }
  }
  return undefined
}

const parseStages = (raw: unknown, warnings: string[]): Stage[] => {
  if (!Array.isArray(raw)) return []
  const stages: Stage[] = []
  raw.forEach((entry, i) => {
    const rec = asRecord(entry)
    if (!rec) {
      warnings.push(`sleep stage ${i}: not an object — skipped.`)
      return
    }
    const start = instantAt(rec, 'start_time', 'start')
    const end = instantAt(rec, 'end_time', 'end')
    if (!start || !end) {
      warnings.push(`sleep stage ${i}: missing start_time/end_time — skipped.`)
      return
    }
    const kind = stageKindOf(rec.stage ?? rec.type)
    if (kind === undefined) {
      warnings.push(`sleep stage ${i}: unrecognized stage value ${JSON.stringify(rec.stage ?? rec.type)} — recorded as 'unknown'.`)
    }
    stages.push({kind: kind ?? 'unknown', start, end})
  })
  return stages
}

const parseSamples = (raw: unknown, valueKeys: string[], label: string, warnings: string[]): Sample[] => {
  if (!Array.isArray(raw)) return []
  const samples: Sample[] = []
  raw.forEach((entry, i) => {
    const rec = asRecord(entry)
    if (!rec) {
      warnings.push(`${label} ${i}: not an object — skipped.`)
      return
    }
    const at = instantAt(rec, 'time', 'start_time')
    const value = numAt(rec, ...valueKeys)
    if (!at || value === undefined) {
      warnings.push(`${label} ${i}: missing time or value — skipped.`)
      return
    }
    samples.push({at, value})
  })
  return samples
}

interface ParsedSleepSession {
  externalId?: string
  start: Date
  end: Date
  stages: Stage[]
}

const parseSleepSession = (entry: unknown, index: number, warnings: string[]): ParsedSleepSession | undefined => {
  const rec = asRecord(entry)
  if (!rec) {
    warnings.push(`sleep session ${index}: not an object — skipped.`)
    return undefined
  }
  const end = instantAt(rec, 'end_time', 'session_end_time')
  let start = instantAt(rec, 'start_time', 'session_start_time')
  const durationSeconds = numAt(rec, 'duration_seconds')
  if (!start && end && durationSeconds !== undefined) start = new Date(end.getTime() - durationSeconds * 1000)
  if (!start || !end) {
    warnings.push(
      `sleep session ${index}: could not determine start/end time `
      + '(need start_time/session_start_time, or session_end_time + duration_seconds) — skipped.',
    )
    return undefined
  }
  const stages = parseStages(rec.stages, warnings).sort((a, b) => a.start.getTime() - b.start.getTime())
  return {externalId: externalIdOf(rec), start, end, stages}
}

export const parseHealthConnectPayload = (json: unknown): {sessions: ImportedSession[]; warnings: string[]} => {
  const warnings: string[] = []
  const root = asRecord(json)
  if (!root) return {sessions: [], warnings: ['Health Connect payload is not a JSON object.']}

  // `sleep_session` isn't a documented key (the real one is `sleep`) — kept
  // as a tolerant alternate per this file's header note.
  const sleepRaw = [
    ...(Array.isArray(root.sleep) ? root.sleep : []),
    ...(Array.isArray(root.sleep_session) ? root.sleep_session : []),
  ]

  // "Samples are the whole export's; the derivation keeps those inside the
  // session's window" (see `ImportedSession` in engine/types.ts) — every
  // session below gets the SAME sample arrays, unfiltered.
  const heartRate = parseSamples(root.heart_rate, ['bpm', 'beats_per_minute'], 'heart_rate', warnings)
  const hrv = parseSamples(
    root.heart_rate_variability ?? root.heart_rate_variability_rmssd,
    ['rmssd_millis', 'heart_rate_variability_millis', 'value'],
    'heart_rate_variability',
    warnings,
  )
  const spo2 = parseSamples(root.oxygen_saturation, ['percentage'], 'oxygen_saturation', warnings)
  const skinTemp = parseSamples(root.skin_temperature, ['delta_celsius', 'delta'], 'skin_temperature', warnings)
  const respRate = parseSamples(root.respiratory_rate, ['rate'], 'respiratory_rate', warnings)

  const sessions: ImportedSession[] = []
  sleepRaw.forEach((entry, i) => {
    const parsed = parseSleepSession(entry, i, warnings)
    if (!parsed) return
    sessions.push({
      source: 'health-connect',
      externalId: parsed.externalId,
      start: parsed.start,
      end: parsed.end,
      stages: parsed.stages,
      heartRate,
      hrv,
      spo2,
      skinTemp,
      respRate,
    })
  })

  // Time-sorted, so the derivation can binary-search each session's window.
  for (const session of sessions) {
    for (const samples of [session.heartRate, session.hrv, session.spo2, session.skinTemp, session.respRate]) {
      samples.sort((a, b) => a.at.getTime() - b.at.getTime())
    }
  }
  return {sessions, warnings}
}
