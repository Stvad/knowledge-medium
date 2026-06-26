import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BINARY_MAGIC_BYTES, hasBinaryEnvelopeMagic } from '../../sync/crypto/binaryEnvelope.js'
import { collectPaged } from './paginate.js'
import type { AuditIO, ObjectEntry, ObjectVerdict } from './types.js'

const BUCKET = 'attachments'
const PAGE = 1000

export interface SupabaseAuditIODeps {
  url: string
  /** A privileged key that bypasses RLS (read every workspace's objects). Read
   *  from the environment by the entrypoint and passed in — never embedded in
   *  `src`. */
  serviceKey: string
  /** Injectable for tests. */
  client?: SupabaseClient
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch
}

/**
 * The real {@link AuditIO}, backed by supabase-js for the metadata listing (auth
 * headers, query building, typed errors handled by the client) and a single
 * raw Range-GET for the byte peek (supabase-js `download` has no Range option).
 *
 * Both list paths are paginated through {@link collectPaged} with an EXPLICIT
 * stable sort (`order('id')` / `sortBy: name.asc`) — offset pagination over an
 * unordered result can silently skip rows.
 */
export function createSupabaseAuditIO(deps: SupabaseAuditIODeps): AuditIO {
  const client = deps.client ?? createClient(deps.url, deps.serviceKey)
  const fetchFn = deps.fetchFn ?? fetch
  const base = deps.url.replace(/\/$/, '')
  const authHeaders = { apikey: deps.serviceKey, authorization: `Bearer ${deps.serviceKey}` }

  return {
    async listE2eeWorkspaceIds() {
      return collectPaged(async (offset) => {
        const { data, error } = await client
          .from('workspaces')
          .select('id')
          .eq('encryption_mode', 'e2ee')
          .order('id', { ascending: true })
          .range(offset, offset + PAGE - 1)
        // Code only — never the message/body: this runs in public CI and a body
        // could echo a workspace id.
        if (error) throw new Error(`workspaces query failed (${error.code || 'error'})`)
        return (data ?? []).map((w) => w.id as string)
      })
    },

    async listObjects(workspaceId) {
      return collectPaged<ObjectEntry>(async (offset) => {
        const { data, error } = await client.storage.from(BUCKET).list(workspaceId, {
          limit: PAGE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        })
        if (error) throw new Error(`storage list failed (${error.name || 'error'})`)
        // A nested subfolder comes back with a null id; a file has one.
        return (data ?? []).map((o) => ({ name: o.name, isFolder: o.id === null }))
      })
    },

    async readObjectVerdict(path): Promise<ObjectVerdict> {
      // The whole op is guarded: the fetch resolves on headers, so the body
      // (arrayBuffer) streams lazily and can drop mid-stream — any per-object
      // failure must degrade to 'unreadable', never abort the scan.
      try {
        const encoded = path.split('/').map(encodeURIComponent).join('/')
        const res = await fetchFn(`${base}/storage/v1/object/authenticated/${BUCKET}/${encoded}`, {
          headers: { ...authHeaders, range: `bytes=0-${BINARY_MAGIC_BYTES - 1}` },
        })
        if (res.status === 404) return 'gone'
        if (!res.ok) return 'unreadable'
        const head = new Uint8Array(await res.arrayBuffer())
        return hasBinaryEnvelopeMagic(head) ? 'ok' : 'plaintext'
      } catch {
        return 'unreadable'
      }
    },
  }
}
