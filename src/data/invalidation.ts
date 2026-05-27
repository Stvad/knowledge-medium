import type { BlockData } from '@/data/api'

export type PluginInvalidationKeys = ReadonlySet<string> | readonly string[]
export type PluginInvalidationMap = ReadonlyMap<string, PluginInvalidationKeys>

export interface ChangeSnapshotSide {
  id?: string
  parentId: string | null
  referenceTargetId?: string | null
  orderKey?: string
  workspaceId: string
  deleted?: boolean
  /** Block content. Surfaced here for the kernel `content` invalidation
   *  channel — fires when content actually changes, so substring-search
   *  / recent-blocks queries don't invalidate on UiState property
   *  writes. Type-level only: runtime values are full `BlockData`
   *  snapshots that already carry `content`. */
  content?: string
  references?: ReadonlyArray<{ id: string; sourceField?: string }>
  /** Encoded property bag — same shape as `BlockData.properties`. Surfaced
   *  here so invalidation rules can diff per-property values without
   *  importing `BlockData`. The runtime values are full `BlockData`
   *  snapshots (`SnapshotEntry`); this type is the slim view rules see. */
  properties?: Readonly<Record<string, unknown>>
}

export interface ChangeSnapshot {
  before: ChangeSnapshotSide | null
  after: ChangeSnapshotSide | null
}

export interface InvalidationRowEvent {
  blockId: string
  kind: string
  before: BlockData | null
  after: BlockData | null
}

export type PluginInvalidationEmit = (channel: string, key: string) => void

export interface InvalidationRule {
  id: string
  collectFromSnapshots?: (
    snapshots: ReadonlyMap<string, ChangeSnapshot>,
    emit: PluginInvalidationEmit,
  ) => void
  collectFromRowEvent?: (
    event: InvalidationRowEvent,
    emit: PluginInvalidationEmit,
  ) => void
}

export type MutablePluginInvalidationMap = Map<string, Set<string>>

export const emitPluginInvalidation = (
  out: MutablePluginInvalidationMap,
  channel: string,
  key: string,
): void => {
  if (!channel || !key) return
  let keys = out.get(channel)
  if (!keys) {
    keys = new Set()
    out.set(channel, keys)
  }
  keys.add(key)
}

export const createPluginInvalidationEmitter = (
  out: MutablePluginInvalidationMap,
): PluginInvalidationEmit =>
  (channel, key) => emitPluginInvalidation(out, channel, key)

export const collectPluginInvalidationsFromSnapshots = (
  rules: readonly InvalidationRule[],
  snapshots: ReadonlyMap<string, ChangeSnapshot>,
): PluginInvalidationMap | undefined => {
  if (rules.length === 0 || snapshots.size === 0) return undefined
  const out: MutablePluginInvalidationMap = new Map()
  const emit = createPluginInvalidationEmitter(out)
  for (const rule of rules) rule.collectFromSnapshots?.(snapshots, emit)
  return out.size > 0 ? out : undefined
}

export const pluginInvalidationSize = (
  pluginInvalidations: PluginInvalidationMap | undefined,
): number => {
  if (!pluginInvalidations) return 0
  let total = 0
  for (const keys of pluginInvalidations.values()) {
    total += 'size' in keys ? keys.size : keys.length
  }
  return total
}
