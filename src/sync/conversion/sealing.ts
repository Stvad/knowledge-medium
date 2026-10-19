/**
 * What the re-seal and its verify share: when a value counts as sealed, the
 * open-check, the one way a sealed row is sent, and paging the server's rows.
 */

import { contentAad } from '../crypto/aad.js'
import { open } from '../crypto/aead.js'
import { encodeForWire, SEALED_COLUMNS, type GetCek, type WireBlockColumns } from '../transform.js'
import type { ConversionServer, ResealPatch, ServerBlockRow } from './conversionServer.js'

export type ContentColumns = Pick<WireBlockColumns, (typeof SEALED_COLUMNS)[number]>

/** Rows per page: one read, then at most one `apply_block_patches` call, which
 *  stays under the upload path's per-call cap (`MAX_PATCHES_PER_SUPABASE_RPC`). */
export const RESEAL_PAGE_SIZE = 200

export type ConversionRefusalReason = 'not-e2ee' | 'open-check' | 'unsealed' | 'no-record' | 'unrepaired'

const REFUSALS: Record<ConversionRefusalReason, string> = {
  'not-e2ee': 'the server does not hold this workspace as e2ee',
  'open-check': 'sealed values did not open to their plaintext under the workspace key',
  'unsealed': 'rows are not sealed yet',
  'no-record': 'rows were sealed by something other than the re-seal',
  'unrepaired': 'rows still differ from their re-seal record after being re-sent',
}

/** The server's data, not the transport, is why the run stopped, so retrying
 *  the same call won't get past it. */
export class ConversionRefusal extends Error {
  constructor(
    readonly reason: ConversionRefusalReason,
    readonly blockIds: readonly string[] = [],
  ) {
    super(`conversion refused: ${REFUSALS[reason]}${blockIds.length > 0 ? ` (${blockIds.join(', ')})` : ''}`)
    this.name = 'ConversionRefusal'
  }
}

/** `public.is_enc_v1_envelope`, the server's test of a sealed value: the
 *  prefix plus a base64url payload of at least a nonce and an auth tag. The
 *  purge applies it to every row, so the re-seal must call a value sealed
 *  exactly when the server does, or it skips a row the purge then refuses on. */
const ENVELOPE_SHAPE = /^enc:v1:([A-Za-z0-9_-]{4}){9,}([A-Za-z0-9_-]{4}|[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})$/

export const isSealedValue = (value: string): boolean => ENVELOPE_SHAPE.test(value)

export const isSealedRow = (row: ContentColumns): boolean =>
  SEALED_COLUMNS.every(column => isSealedValue(row[column]))

export const contentColumnsOf = (row: ContentColumns): ContentColumns => ({
  content: row.content,
  properties_json: row.properties_json,
  references_json: row.references_json,
})

/** Whether every sealed column opens, under `wk` and the AAD of the row it is
 *  sent to or read from, to exactly `expected`. */
export const opensTo = async (
  wk: CryptoKey,
  row: Pick<WireBlockColumns, 'id' | 'workspace_id'>,
  sealed: ContentColumns,
  expected: ContentColumns,
): Promise<boolean> => {
  for (const column of SEALED_COLUMNS) {
    try {
      const opened = await open(wk, sealed[column], contentAad(row.id, row.workspace_id, column))
      if (opened !== expected[column]) return false
    } catch {
      return false
    }
  }
  return true
}

export const idsOf = (rows: readonly {readonly id: string}[]): string[] => rows.map(row => row.id)

/** The server refuses plaintext writes once the flip has happened, but nothing
 *  refuses ciphertext in a plaintext workspace, and every device pinned to
 *  plaintext would copy it into its `blocks`. The mode never goes back to
 *  `none`, so checking once per run is enough. */
export const requireE2eeOnServer = async (server: ConversionServer, workspaceId: string): Promise<void> => {
  if ((await server.readEncryptionMode(workspaceId)) !== 'e2ee') throw new ConversionRefusal('not-e2ee')
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
   *  is the patch's base. */
  readonly row: ServerBlockRow
  readonly plaintext: ContentColumns
}

/** Seal each target's plaintext for its server row, check every sealed value
 *  opens back to it, then send them in one `apply_block_patches` call. */
export const sealAndSend = async (
  server: ConversionServer,
  workspaceId: string,
  targets: readonly SealTarget[],
  wk: CryptoKey,
): Promise<void> => {
  if (targets.length === 0) return
  // A row from any other workspace gets no key, so it is refused, not sealed.
  const getCek: GetCek = async id => (id === workspaceId ? wk : null)
  const patches = await Promise.all(targets.map(async ({row, plaintext}): Promise<ResealPatch> => {
    const sealed = await encodeForWire({id: row.id, workspace_id: row.workspace_id, ...contentColumnsOf(plaintext)}, 'e2ee', getCek)
    return {id: row.id, ...contentColumnsOf(sealed), base_updated_at: row.updated_at}
  }))

  // Defence in depth: today's seal step cannot fail this. It opens each value
  // independently of how `encodeForWire` picked its key and AAD, so a bug there
  // is refused before anything is sent rather than found after a multi-hour pass.
  const opens = await Promise.all(targets.map(({row, plaintext}, i) => opensTo(wk, row, patches[i], plaintext)))
  const unopened = targets.filter((_, i) => !opens[i]).map(target => target.row)
  if (unopened.length > 0) throw new ConversionRefusal('open-check', idsOf(unopened))

  await server.applyBlockPatches(patches)
}
