/** Helpers for rendering `ps_crud_rejected` rows in the UI.
 *
 *  Two formats are normalised here so the dialog stays simple:
 *  - `error_message` from Supabase comes back as the JSON-stringified
 *    PostgrestError shape `{code, details, hint, message}` rather than
 *    a flat human sentence. Unwrap once so the dialog can show the
 *    user-facing `message` prominently and keep the rest collapsed.
 *  - `data` is the upload envelope `{op, type, id, data}`. Render a
 *    short op summary so a row reads as "PUT blocks abc12345…" at a
 *    glance without expanding into the full payload. */

import { truncate } from '@/utils/string'

export interface ParsedRejectionError {
  message: string
  code: string | null
  details: string | null
  hint: string | null
}

export const parseRejectionError = (raw: string | null): ParsedRejectionError => {
  if (raw === null || raw === '') {
    return {message: '(no error message)', code: null, details: null, hint: null}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      message: pickString(parsed, 'message') ?? raw,
      code: pickString(parsed, 'code'),
      details: pickString(parsed, 'details'),
      hint: pickString(parsed, 'hint'),
    }
  } catch {
    // Not JSON — Supabase's PostgrestError serialisation is the
    // common case here, but a Plain Error throw (or a non-Error
    // value) lands as the raw message string. Fall back to that.
    return {message: raw, code: null, details: null, hint: null}
  }
}

const pickString = (obj: Record<string, unknown>, key: string): string | null => {
  const value = obj[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export interface RejectionOpSummary {
  op: string
  table: string
  id: string
  idShort: string
}

export const summarizeOp = (rawData: string): RejectionOpSummary => {
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>
    const op = pickString(parsed, 'op') ?? 'OP'
    const table = pickString(parsed, 'type') ?? 'unknown'
    const id = pickString(parsed, 'id') ?? '(no id)'
    return {op, table, id, idShort: shortenId(id)}
  } catch {
    return {op: 'OP', table: 'unknown', id: rawData, idShort: shortenId(rawData)}
  }
}

export const shortenId = (id: string): string => {
  if (id.length <= 13) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

/** Block-level detail pulled out of a rejected upload envelope's `data`
 *  payload, so the dialog can show WHICH block and WHAT was being written —
 *  not just the op + id. The three content columns may hold e2ee ciphertext
 *  (`enc:v1:` envelopes), so a preview is only offered for plaintext; an
 *  encrypted payload is flagged instead of dumping unreadable bytes. */
export interface RejectedBlockDetails {
  /** The block's workspace, or null when the payload omits it (e.g. the
   *  pre-fix stale-trigger bug stripped workspace_id from content-only
   *  PATCHes — surfacing its absence is itself diagnostic). */
  workspaceId: string | null
  /** The payload's data columns, minus workspace_id (shown separately). For a
   *  PATCH this reads as the changed fields; for a PUT, the full column set. */
  fields: string[]
  /** Truncated plaintext `content`, or null when absent/empty/encrypted. */
  contentPreview: string | null
  /** True when any content column carries an `enc:v1:` ciphertext envelope. */
  encrypted: boolean
}

const CONTENT_COLUMNS = ['content', 'properties_json', 'references_json'] as const
const ENC_V1_PREFIX = 'enc:v1:'
const CONTENT_PREVIEW_MAX = 80

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const extractBlockDetails = (rawData: string): RejectedBlockDetails => {
  const empty: RejectedBlockDetails = {
    workspaceId: null, fields: [], contentPreview: null, encrypted: false,
  }
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>
    const data = isRecord(parsed.data) ? parsed.data : {}
    const content = typeof data.content === 'string' ? data.content : null
    const encrypted = CONTENT_COLUMNS.some(
      column => typeof data[column] === 'string'
        && (data[column] as string).startsWith(ENC_V1_PREFIX),
    )
    const contentPreview = content && !content.startsWith(ENC_V1_PREFIX)
      ? truncate(content, CONTENT_PREVIEW_MAX)
      : null
    return {
      workspaceId: pickString(data, 'workspace_id'),
      fields: Object.keys(data).filter(key => key !== 'workspace_id'),
      contentPreview,
      encrypted,
    }
  } catch {
    return empty
  }
}
