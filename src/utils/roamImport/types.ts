// Roam JSON export types — shapes seen in the user's `export-pages` format.
// Roam stores duplicated keys under both `:block/X` (Datalog-style) and `X`
// (camel-style); the loader treats them interchangeably and prefers the
// non-namespaced form when both are present.

export interface RoamUserRef {
  ':user/uid'?: string
}

export interface RoamUidRef {
  uid?: string
  ':block/uid'?: string
}

export interface RoamBlock {
  // Roam exports omit `:block/string` for blocks that were never given
  // any content (empty bullets) — treat absence as "".
  string?: string
  uid: string
  'create-time'?: number
  'edit-time'?: number
  heading?: number
  ':children/view-type'?: string
  ':block/view-type'?: string
  refs?: RoamUidRef[]
  ':block/refs'?: RoamUidRef[]
  ':block/props'?: Record<string, unknown>
  props?: Record<string, unknown>
  ':create/user'?: RoamUserRef | null
  ':edit/user'?: RoamUserRef | null
  children?: RoamBlock[]
}

// Top-level Roam attribute values land directly on the block, e.g.
// `:readwise-highlight-id`. We pull these via this helper and treat them
// as opaque pass-through props — keeping them off the typed RoamBlock
// interface keeps known-field access typed.
export const getExtraRoamProps = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith(':')) continue
    if (
      key === ':block/props' || key === ':block/refs' ||
      key === ':create/user' || key === ':edit/user' ||
      key === ':block/uid' || key === ':log/id' ||
      key === ':children/view-type'
    ) continue
    out[key] = value
  }
  return out
}

export interface RoamPage extends Omit<RoamBlock, 'string'> {
  title: string
  ':log/id'?: number
}

export type RoamExport = RoamPage[]
