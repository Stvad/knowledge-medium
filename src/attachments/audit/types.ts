/**
 * Types for the off-path attachments ciphertext audit (design §10.1 / §17).
 *
 * The audit verifies that every object under an E2EE-workspace prefix in the
 * `attachments` bucket is an `encb:v1:` ciphertext envelope — a tripwire that
 * turns an honest-client regression (uploading plaintext) from silent into loud.
 * The logic here is pure and injected via {@link AuditIO}, so it is unit-tested
 * without any network (the I/O adapter, supabaseAuditIO, is tested separately).
 */

/** Per-object verdict from reading just the magic bytes. */
export type ObjectVerdict =
  | 'ok' // an encb:v1: ciphertext envelope — as required
  | 'plaintext' // readable but not encb:v1: (incl. an empty / truncated object)
  | 'unreadable' // a read failure (416 empty / 5xx / network) — flag, don't abort
  | 'gone' // 404 — deleted between list and read; benign, skip

export type FindingKind = 'plaintext' | 'nested' | 'unreadable'

export interface Finding {
  kind: FindingKind
  /** `<workspaceId>/<key>`, or `<workspaceId>/<folder>/` for a nested entry. */
  path: string
}

/** A top-level entry under a workspace prefix. The layout is flat (`<ws>/<key>`);
 *  a nested subfolder surfaces as `isFolder`. */
export interface ObjectEntry {
  /** Path relative to the workspace prefix (the content-key, or a folder name). */
  name: string
  isFolder: boolean
}

/**
 * The I/O surface the audit drives. Real implementation: supabaseAuditIO.
 * Contract: `readObjectVerdict` MUST NOT throw — a per-object failure is a
 * verdict ('unreadable'/'gone'), never a fatal abort. The list methods MAY throw
 * — an enumeration failure should abort, since we can't audit what we can't list.
 */
export interface AuditIO {
  listE2eeWorkspaceIds(): Promise<string[]>
  listObjects(workspaceId: string): Promise<ObjectEntry[]>
  readObjectVerdict(path: string): Promise<ObjectVerdict>
}

export interface AuditResult {
  workspaces: number
  scanned: number
  findings: Finding[]
}
