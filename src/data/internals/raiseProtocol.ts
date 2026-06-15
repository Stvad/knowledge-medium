/**
 * Owner module for the SQLite-trigger → JS error-translation protocol.
 *
 * Two storage-layer integrity triggers RAISE a structured message that
 * `repo.tx` catches and re-throws as a typed user-domain error:
 *
 *   - `block_aliases_workspace_alias_unique` → `alias_collision` →
 *     `ProcessorRejection('alias.collision', …)`
 *   - `blocks_parent_not_deleted_check_{insert,update}` → `parent_deleted`
 *     → `ParentDeletedError(parentId)`
 *
 * The wire format spans two files — `clientSchema.ts` emits the RAISE
 * string inside the trigger SQL, `repo.ts` parses it back — so the
 * separator, the field-encoding, and the prefixes all live here. The SQL
 * side imports `RAISE_FIELD_SEP_SQL` + the prefixes; the JS side imports
 * the parsers. Neither side hard-codes the contract, so they can't drift.
 */

// ASCII unit separator delimits the fields. Field contents on the alias
// path are hex-encoded so the separator is guaranteed-distinct from any
// field byte — earlier comments asserted the codec rejected control
// chars, but `codecs.string` only checks typeof; the encoding can't rely
// on that. The trigger uses `char(31)` (see RAISE_FIELD_SEP_SQL) for the
// same delimiter and `hex(NEW.<col>)` for each field.
export const RAISE_FIELD_SEP = '\x1f'

/** SQL fragment that produces the field separator inside a RAISE
 *  expression — derived from `RAISE_FIELD_SEP` so the SQL and JS sides
 *  share one source of truth for the delimiter byte. */
export const RAISE_FIELD_SEP_SQL = `char(${RAISE_FIELD_SEP.charCodeAt(0)})`

export const ALIAS_COLLISION_RAISE_PREFIX = 'alias_collision'
export const PARENT_DELETED_RAISE_PREFIX = 'parent_deleted'

/** Structured payload of the `block_aliases_workspace_alias_unique`
 *  trigger's RAISE message. The trigger encodes everything it cheaply
 *  can (the SQL RAISE context has NEW.* but no committed table reads) so
 *  the JS side only does a single PK-style lookup for the rest. */
export interface ParsedAliasCollision {
  workspaceId: string
  alias: string
  /** The block that the user tried to make claim the alias — the
   *  attempting row. */
  attemptedBlockId: string
}

/** Decode SQLite's `hex()` output (uppercase hex of the UTF-8 bytes)
 *  back to the original string. Empty input decodes to `''`. */
const decodeHexUtf8 = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

/** Recognise the trigger-raised parent-deleted error from
 *  `blocks_parent_not_deleted_check_{insert,update}`. The payload is
 *  the bare parent id — block ids are UUIDs or deterministic ids
 *  (hex + `:` / `-`), so the unit separator never appears in them
 *  and the hex encoding the alias parser needs isn't required here.
 *  Returns the parsed id on match, `null` otherwise. */
export const parseParentDeletedError = (err: unknown): {parentId: string} | null => {
  if (err === null || typeof err !== 'object') return null
  const msg = (err as {message?: unknown}).message
  if (typeof msg !== 'string') return null
  const needle = `${PARENT_DELETED_RAISE_PREFIX}${RAISE_FIELD_SEP}`
  const idx = msg.indexOf(needle)
  if (idx === -1) return null
  const tail = msg.slice(idx + needle.length)
  // SQLite wrappers may append context text after the payload, so
  // split on the unit separator and take the first part. Block ids
  // never contain `\x1f`, so the first part is the id verbatim.
  const parentId = tail.split(RAISE_FIELD_SEP)[0]
  if (parentId.length === 0) return null
  return {parentId}
}

/** Recognise the trigger-raised alias-collision error inside whatever
 *  wrapping SQLite + better-sqlite3 + PowerSync layer it on. Returns
 *  parsed fields when matched, `null` otherwise (the caller falls
 *  back to its existing error handling). The three field values are
 *  hex-encoded in the RAISE message so the unit-separator can be
 *  used as a delimiter regardless of what bytes the alias text
 *  contains. */
export const parseAliasCollisionError = (err: unknown): ParsedAliasCollision | null => {
  if (err === null || typeof err !== 'object') return null
  const msg = (err as {message?: unknown}).message
  if (typeof msg !== 'string') return null
  const needle = `${ALIAS_COLLISION_RAISE_PREFIX}${RAISE_FIELD_SEP}`
  const idx = msg.indexOf(needle)
  if (idx === -1) return null
  const tail = msg.slice(idx + needle.length)
  // tail = `<HEX(workspaceId)>\x1f<HEX(alias)>\x1f<HEX(attemptedBlockId)>`
  // possibly followed by SQLite wrapper text. The hex alphabet is
  // [0-9A-F], so any byte from the wrapper that ISN'T hex (typically
  // it starts with a quote or a colon) terminates the third field.
  // Splitting on the separator yields three hex-only parts whose
  // tail may carry wrapper garbage on the third field — we
  // hex-decode each, stopping at the first non-hex character on the
  // last field to avoid eating any wrapper suffix.
  const parts = tail.split(RAISE_FIELD_SEP)
  if (parts.length < 3) return null
  const trimToHex = (s: string): string => {
    const m = s.match(/^[0-9A-Fa-f]*/)
    const hex = m === null ? '' : m[0]
    // hex() emits pairs of nibbles; if a wrapper byte landed on an
    // odd boundary somehow, drop the trailing half-pair.
    return hex.length % 2 === 0 ? hex : hex.slice(0, -1)
  }
  try {
    return {
      workspaceId: decodeHexUtf8(trimToHex(parts[0])),
      alias: decodeHexUtf8(trimToHex(parts[1])),
      attemptedBlockId: decodeHexUtf8(trimToHex(parts[2])),
    }
  } catch {
    return null
  }
}
