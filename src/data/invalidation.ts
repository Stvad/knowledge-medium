export type PluginInvalidationKeys = ReadonlySet<string> | readonly string[]
export type PluginInvalidationMap = ReadonlyMap<string, PluginInvalidationKeys>

export interface ChangeSnapshotSide {
  id?: string
  parentId: string | null
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

export type PluginInvalidationEmit = (channel: string, key: string) => void

export interface InvalidationRule {
  id: string
  collectFromSnapshots?: (
    snapshots: ReadonlyMap<string, ChangeSnapshot>,
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

// ──── Kernel invalidation channels + dependency keys ────
//
// The channel ids the kernel emits on after tx commits / sync-applied
// row events, plus the key builders that format each channel's
// dependency key. Plugin queries declare `{kind:'plugin', channel, key}`
// deps against these (e.g. backlinks depends on
// TYPED_BLOCKS_STRUCTURE_CHANNEL + typedBlocksStructureKey). The kernel's
// own emit rules live in `internals/kernelInvalidation.ts`.

export const TYPED_BLOCKS_LIVE_CHANNEL = 'typedBlocks.live'
export const TYPED_BLOCKS_TYPE_CHANNEL = 'typedBlocks.type'
export const TYPED_BLOCKS_PROPERTY_CHANNEL = 'typedBlocks.property'
export const TYPED_BLOCKS_REFERENCE_CHANNEL = 'typedBlocks.reference'
export const TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL = 'typedBlocks.referenceField'
export const TYPED_BLOCKS_STRUCTURE_CHANNEL = 'typedBlocks.structure'
export const TYPED_BLOCKS_REFS_OF_CHANNEL = 'typedBlocks.refsOf'
export const TYPED_BLOCKS_LABEL_CHANNEL = 'typedBlocks.label'
export const KERNEL_ALIASES_CHANNEL = 'kernel.aliases'
export const KERNEL_CONTENT_CHANNEL = 'kernel.content'

const SEP = '\u0000'

export const typedBlocksLiveKey = (workspaceId: string): string => workspaceId
export const typedBlocksTypeKey = (workspaceId: string, type: string): string =>
  `${workspaceId}${SEP}${type}`
export const typedBlocksPropertyKey = (workspaceId: string, name: string): string =>
  `${workspaceId}${SEP}${name}`
export const typedBlocksReferenceKey = (workspaceId: string, targetId: string): string =>
  `${workspaceId}${SEP}${targetId}`
export const typedBlocksReferenceFieldKey = (
  workspaceId: string,
  targetId: string,
  sourceField: string,
): string => `${workspaceId}${SEP}${targetId}${SEP}${sourceField}`
export const typedBlocksStructureKey = (workspaceId: string, blockId: string): string =>
  `${workspaceId}${SEP}${blockId}`
export const typedBlocksRefsOfKey = (workspaceId: string, blockId: string): string =>
  `${workspaceId}${SEP}${blockId}`
export const typedBlocksLabelKey = (workspaceId: string, blockId: string): string =>
  `${workspaceId}${SEP}${blockId}`

export const kernelAliasesKey = (workspaceId: string): string => workspaceId
export const kernelContentKey = (workspaceId: string): string => workspaceId
