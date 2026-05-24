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

const shortenId = (id: string): string => {
  if (id.length <= 13) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}
