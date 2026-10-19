/**
 * What the re-seal and its verify share: when a value counts as sealed, the
 * key check, the open-check, the one way a sealed row is sent, and paging the
 * server's rows.
 */

import { contentAad } from '../crypto/aad.js'
import { open } from '../crypto/aead.js'
import { validateCanary } from '../crypto/canary.js'
import { ENVELOPE_PREFIX, GCM_TAG_BYTES, NONCE_BYTES } from '../crypto/envelope.js'
import { encodeForWire, SEALED_COLUMNS, type GetCek, type WireBlockColumns } from '../transform.js'
import type { ContentColumns, ConversionServer, ResealPatch, ServerBlockRow } from './conversionServer.js'

/** Patches per `apply_block_patches` call, whatever the page size: the call
 *  runs one UPDATE per patch in a single statement, and the upload path caps
 *  it at 500 (`MAX_PATCHES_PER_SUPABASE_RPC`) to stay under the timeout. */
const MAX_PATCHES_PER_CALL = 200

/** Rows per page: one read, then the page's patches. */
export const RESEAL_PAGE_SIZE = MAX_PATCHES_PER_CALL

/** What the re-seal and the verify both take. */
export interface ConversionPassOptions<Progress> {
  readonly server: ConversionServer
  readonly workspaceId: string
  /** The workspace key: the run refuses one that doesn't open the server canary. */
  readonly wk: CryptoKey
  readonly pageSize?: number
  readonly onProgress?: (progress: Progress) => void
  readonly signal?: AbortSignal
}

/** Sealed characters per `apply_block_patches` call. Every patch carries all
 *  three content columns and the call also writes their history, so a page of
 *  large rows is split rather than sent as one transaction that would time out
 *  the same way on every resume. A single larger row still goes alone. */
export const MAX_SEALED_CHARS_PER_CALL = 1_000_000

export type ConversionRefusalReason =
  | 'not-e2ee'
  | 'wrong-key'
  | 'open-check'
  | 'unsealed'
  | 'no-record'
  | 'unrepaired'
  | 'written-since-seal'

const REFUSALS: Record<ConversionRefusalReason, string> = {
  'not-e2ee': 'the server does not hold this workspace as e2ee',
  'wrong-key': 'the key does not open the workspace canary',
  'open-check': 'sealed values did not open to their plaintext under the workspace key',
  'unsealed': 'rows are not sealed yet',
  'no-record': 'rows have no re-seal record: something other than the re-seal sealed them',
  'unrepaired': 'rows still differ from their re-seal record after being re-sent',
  'written-since-seal': 'rows differ from their re-seal record and were written after it, so re-sending would overwrite that write',
}

/** The server's data, not the transport or the session, is why the run
 *  stopped, so retrying the same call won't get past it. */
export class ConversionRefusal extends Error {
  constructor(
    readonly reason: ConversionRefusalReason,
    readonly blockIds: readonly string[] = [],
  ) {
    super(`conversion refused: ${REFUSALS[reason]}${blockIds.length > 0 ? ` (${blockIds.join(', ')})` : ''}`)
    this.name = 'ConversionRefusal'
  }
}

/** The shortest payload `public.is_enc_v1_envelope` accepts: a nonce and an
 *  auth tag, base64url-encoded without padding. */
const MIN_PAYLOAD_CHARS = Math.ceil(((NONCE_BYTES + GCM_TAG_BYTES) * 4) / 3)
const BASE64URL_PAYLOAD = /^[A-Za-z0-9_-]*$/

/** `public.is_enc_v1_envelope`, the server's test of a sealed value, which the
 *  purge applies to every row: the re-seal must call a value sealed exactly
 *  when the server does, or it skips a row the purge then refuses on. Checked
 *  in linear time, since the server's regex, with its repeated group,
 *  overflows V8's backtracking stack on a value of a few megabytes. */
export const isSealedValue = (value: string): boolean => {
  if (!value.startsWith(ENVELOPE_PREFIX)) return false
  const payload = value.slice(ENVELOPE_PREFIX.length)
  // Unpadded base64url never ends with a single leftover character.
  return payload.length >= MIN_PAYLOAD_CHARS && payload.length % 4 !== 1 && BASE64URL_PAYLOAD.test(payload)
}

/** A row the server would take in an e2ee workspace. A row short of it is
 *  plaintext to the re-seal, even when some of its values merely look sealed. */
export const isSealedRow = (row: ContentColumns): boolean =>
  SEALED_COLUMNS.every(column => isSealedValue(row[column]))

export const contentColumnsOf = (row: ContentColumns): ContentColumns => ({
  content: row.content,
  properties_json: row.properties_json,
  references_json: row.references_json,
})

/** Every sealed column opened under `wk` and the AAD of the row it was sealed
 *  for, or null when any of them doesn't open. */
const openSealed = async (
  wk: CryptoKey,
  row: Pick<WireBlockColumns, 'id' | 'workspace_id'>,
  sealed: ContentColumns,
): Promise<ContentColumns | null> => {
  try {
    const [content, properties_json, references_json] = await Promise.all(
      SEALED_COLUMNS.map(column => open(wk, sealed[column], contentAad(row.id, row.workspace_id, column))),
    )
    return {content, properties_json, references_json}
  } catch {
    return null
  }
}

/** Whether every value opens under `wk` with the AAD of one of this row's
 *  content columns: sealed for this row by the key's holder, though perhaps
 *  stored in the wrong column. */
export const sealedForRow = async (
  wk: CryptoKey,
  row: Pick<WireBlockColumns, 'id' | 'workspace_id'>,
  sealed: ContentColumns,
): Promise<boolean> => {
  const opensForSomeColumn = async (value: string): Promise<boolean> => {
    for (const column of SEALED_COLUMNS) {
      try {
        await open(wk, value, contentAad(row.id, row.workspace_id, column))
        return true
      } catch {
        // Sealed for another column, perhaps; try its AAD next.
      }
    }
    return false
  }
  const opens = await Promise.all(SEALED_COLUMNS.map(column => opensForSomeColumn(sealed[column])))
  return opens.every(Boolean)
}

/** Whether every sealed column opens, under `wk` and the AAD of the row it is
 *  sent to or read from, to exactly `expected`. */
export const opensTo = async (
  wk: CryptoKey,
  row: Pick<WireBlockColumns, 'id' | 'workspace_id'>,
  sealed: ContentColumns,
  expected: ContentColumns,
): Promise<boolean> => {
  const opened = await openSealed(wk, row, sealed)
  return opened !== null && SEALED_COLUMNS.every(column => opened[column] === expected[column])
}

export const idsOf = (rows: readonly {readonly id: string}[]): string[] => rows.map(row => row.id)

/** Each pass starts, and verify also ends, here. Nothing server-side refuses
 *  ciphertext in a plaintext workspace, and every device pinned to plaintext
 *  would copy it into its `blocks`; and a key that doesn't open the canary
 *  would seal, or "repair", every row under a key nobody saved. A workspace
 *  this session can't see is a session problem, not a refusal. */
export const requireWorkspaceKey = async (
  server: ConversionServer,
  workspaceId: string,
  wk: CryptoKey,
): Promise<void> => {
  const workspace = await server.readWorkspace(workspaceId)
  if (!workspace) throw new Error(`conversion: workspace ${workspaceId} is not visible to this session`)
  if (workspace.encryption_mode !== 'e2ee' || workspace.wk_canary === null) throw new ConversionRefusal('not-e2ee')
  if (!(await validateCanary(wk, workspace.wk_canary, workspaceId))) throw new ConversionRefusal('wrong-key')
}

/** A lost session reads as an empty table rather than as an error, so each pass
 *  ends by proving it saw every row: as many as the workspace holds, counted
 *  while it is still visible to this session. */
export const requireWholeWorkspace = async (
  server: ConversionServer,
  workspaceId: string,
  wk: CryptoKey,
  seen: number,
): Promise<void> => {
  const total = await server.countBlocks(workspaceId)
  await requireWorkspaceKey(server, workspaceId, wk)
  if (total !== seen) throw new Error(`conversion: the pass saw ${seen} of the workspace's ${total} rows; run it again`)
}

/** The workspace's rows, a page at a time, read only once the previous page has
 *  been handled. */
export async function* serverPages(
  server: ConversionServer,
  workspaceId: string,
  pageSize: number,
  signal?: AbortSignal,
): AsyncGenerator<readonly ServerBlockRow[]> {
  for (let afterId: string | null = null; ;) {
    signal?.throwIfAborted()
    const page = await server.readBlockPage(workspaceId, afterId, pageSize)
    if (page.length === 0) return
    yield page
    afterId = page[page.length - 1].id
  }
}

export interface SealTarget {
  /** The server row as just read: its identity binds the AAD, and its version
   *  is the patch's base. The base versions the write but is no compare-and-swap:
   *  a writer between the read and the send is excluded by the single-client
   *  contract, which the gate enforces while sealing, rather than caught here. */
  readonly row: ServerBlockRow
  readonly plaintext: ContentColumns
}

const sealedChars = (patch: ResealPatch): number =>
  patch.content.length + patch.properties_json.length + patch.references_json.length

const callsOf = (patches: readonly ResealPatch[]): ResealPatch[][] => {
  const calls: ResealPatch[][] = []
  let size = 0
  for (const patch of patches) {
    const chars = sealedChars(patch)
    const last = calls[calls.length - 1]
    if (!last || last.length === MAX_PATCHES_PER_CALL || size + chars > MAX_SEALED_CHARS_PER_CALL) {
      calls.push([])
      size = 0
    }
    calls[calls.length - 1].push(patch)
    size += chars
  }
  return calls
}

/** Seal each target's plaintext for its server row, check every sealed value
 *  opens back to it, then send them through `apply_block_patches`. Nothing is
 *  sent unless every target passes the check. */
export const sealAndSend = async (
  server: ConversionServer,
  workspaceId: string,
  targets: readonly SealTarget[],
  wk: CryptoKey,
): Promise<void> => {
  if (targets.length === 0) return
  // A row from any other workspace gets no key, so it is refused, not sealed.
  const getCek: GetCek = async id => (id === workspaceId ? wk : null)
  const sealed = await Promise.all(targets.map(async ({row, plaintext}) => {
    const columns = await encodeForWire({id: row.id, workspace_id: row.workspace_id, ...contentColumnsOf(plaintext)}, 'e2ee', getCek)
    const patch: ResealPatch = {id: row.id, ...contentColumnsOf(columns), base_updated_at: row.updated_at}
    // Defence in depth: today's seal step cannot fail this. It opens each value
    // independently of how `encodeForWire` picked its key and AAD, so a bug
    // there is refused before anything is sent rather than found after a
    // multi-hour pass.
    return {patch, opens: await opensTo(wk, row, patch, plaintext)}
  }))

  const unopened = targets.filter((_, i) => !sealed[i].opens).map(target => target.row)
  if (unopened.length > 0) throw new ConversionRefusal('open-check', idsOf(unopened))

  for (const call of callsOf(sealed.map(({patch}) => patch))) await server.applyBlockPatches(call)
}
