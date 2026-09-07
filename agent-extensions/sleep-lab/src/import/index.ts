/** Which importer a given set of files needs, and dispatch to it. */

import type {ImportedSession} from '../engine/types'
import {parseHealthConnectPayload} from './healthConnect'
import {parseSamsungExport} from './samsungExport'

export interface ImportFile {
  name: string
  text: string
}

export type ImportDetection =
  | {kind: 'health-connect'; json: unknown}
  | {kind: 'samsung-export'}
  | {kind: 'unknown'; reason: string}

/** Shown by the import dialog: which files to pick out of a Samsung Health
 *  "Download personal data" export folder. */
export const SAMSUNG_SLEEP_FILE_HINT =
  'From the Samsung Health "Download personal data" export, pick the sleep and sleep-stage CSVs — '
  + 'files named like "com.samsung.shealth.sleep.<timestamp>.csv" and '
  + '"com.samsung.health.sleep_stage.<timestamp>.csv". Add the heart-rate, oxygen-saturation, HRV, '
  + 'skin-temperature and respiratory-rate CSVs from the same folder too, if you want those measures.'

/** A single JSON file (or a single pasted blob whose text starts with `{`)
 *  is the Health Connect Webhook payload; any file named with the
 *  `com.samsung.` package prefix is a Samsung Health export. */
export const detectImport = (files: ImportFile[]): ImportDetection => {
  if (files.length === 0) return {kind: 'unknown', reason: 'No files given.'}

  if (files.length === 1) {
    const [file] = files
    const looksJson = file.name.toLowerCase().endsWith('.json') || file.text.trim().startsWith('{')
    if (looksJson) {
      try {
        return {kind: 'health-connect', json: JSON.parse(file.text)}
      } catch (e) {
        return {
          kind: 'unknown',
          reason: `"${file.name}" looks like a Health Connect JSON payload but failed to parse: ${(e as Error).message}`,
        }
      }
    }
  }

  if (files.some(f => f.name.includes('com.samsung.'))) return {kind: 'samsung-export'}

  return {
    kind: 'unknown',
    reason: 'None of the given files look like a Health Connect Webhook payload (a single .json file, or '
      + 'text starting with "{") or a Samsung Health export (a file named "com.samsung.…").',
  }
}

export const importSessions = (files: ImportFile[]): {sessions: ImportedSession[]; warnings: string[]} => {
  const detection = detectImport(files)
  if (detection.kind === 'health-connect') return parseHealthConnectPayload(detection.json)
  if (detection.kind === 'samsung-export') return parseSamsungExport(files)
  return {sessions: [], warnings: [detection.reason]}
}
