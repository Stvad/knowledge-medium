/**
 * The sync boundary (design doc §9 / §11.1).
 *
 * One named place where "what crosses the wire" is transformed, sitting
 * between the app domain and the PowerSync CRUD edge. Two pure functions:
 *
 *   encodeForWire(row, mode, getCek)  — app → wire (encrypt on upload)
 *   decodeFromWire(row, mode, getCek) — wire → app (decrypt on download)
 *
 * For a plaintext workspace both are identity, so plaintext workspaces
 * stay bit-identical to today. For an E2EE workspace they seal/open the
 * three content columns independently with per-column AAD (§9.1), using
 * AES-256-GCM under the workspace key (§6).
 *
 * KEY LOOKUP IS PLUGGABLE. The seam takes `getCek(workspaceId)` rather
 * than reading any global; it returns a usable `CryptoKey` handle (§5),
 * never raw bytes. The simple model implements it as an IndexedDB
 * CryptoKey lookup; a future passphrase hierarchy (§13) would implement
 * it as an in-memory unwrapped-CEK-map read — same call site. Keeping
 * this signature stable is the single most important seam for a cheap
 * hierarchy upgrade later.
 *
 * These functions are intentionally free of any PowerSync / DB coupling:
 * the observer and upload hook (Layout B, §9.2) call them, but the
 * transform itself only knows columns, a mode, and a key lookup.
 */

import { contentAad } from './crypto/aad.js'
import { open, seal } from './crypto/aead.js'

export type SyncMode = 'none' | 'e2ee'

/** Resolve the workspace key for a workspace, or null if not available on
 *  this device (locked / never pasted / plaintext). Returns a usable
 *  CryptoKey handle, never raw bytes (§5). */
export type GetCek = (workspaceId: string) => Promise<CryptoKey | null>

/** The block columns the seam transforms. Identifiers (id, workspace_id)
 *  stay in clear — they're needed for routing and AAD binding — and the
 *  three content columns are the encrypted payload in E2EE mode. Extra
 *  columns on a caller's row object are preserved untouched. */
export interface WireBlockColumns {
  readonly id: string
  readonly workspace_id: string
  readonly content: string
  readonly properties_json: string
  readonly references_json: string
}

/** The three columns sealed independently in E2EE mode (§9.1). */
const CONTENT_COLUMNS = ['content', 'properties_json', 'references_json'] as const

const requireKey = async (
  getCek: GetCek,
  workspaceId: string,
): Promise<CryptoKey> => {
  const key = await getCek(workspaceId)
  if (!key) {
    throw new Error(`sync transform: no workspace key available for ${workspaceId}`)
  }
  return key
}

/** Apply `xform` to each of the three content columns, returning a new row
 *  with all other columns preserved. `xform` runs under the workspace key
 *  with each column's own AAD (§9.1). Shared by encode (seal) and decode
 *  (open) so the column set and AAD construction live in one place. */
const transformContentColumns = async <T extends WireBlockColumns>(
  row: T,
  mode: SyncMode,
  getCek: GetCek,
  xform: (key: CryptoKey, value: string, aad: Uint8Array<ArrayBuffer>) => Promise<string>,
): Promise<T> => {
  if (mode === 'none') return row
  const key = await requireKey(getCek, row.workspace_id)
  const transformed: Partial<Record<(typeof CONTENT_COLUMNS)[number], string>> = {}
  for (const column of CONTENT_COLUMNS) {
    transformed[column] = await xform(key, row[column], contentAad(row.id, row.workspace_id, column))
  }
  return { ...row, ...transformed }
}

/** App → wire. Identity for plaintext; per-column AES-GCM seal for E2EE. */
export const encodeForWire = <T extends WireBlockColumns>(
  row: T,
  mode: SyncMode,
  getCek: GetCek,
): Promise<T> => transformContentColumns(row, mode, getCek, seal)

/** Wire → app. Identity for plaintext; per-column AES-GCM open for E2EE. */
export const decodeFromWire = <T extends WireBlockColumns>(
  row: T,
  mode: SyncMode,
  getCek: GetCek,
): Promise<T> => transformContentColumns(row, mode, getCek, open)
