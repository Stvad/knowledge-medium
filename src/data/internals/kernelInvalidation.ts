/**
 * Narrow-dep invalidation for kernel queries.
 *
 * Replaces a handful of `{kind:'workspace', workspaceId}` deps that used to
 * fire on every write in the workspace (including UiState focus writes,
 * which is what drove the navigation perf regression) with channels keyed
 * to the dimensions each query actually filters on.
 *
 * Channels emitted by this rule:
 *
 *   typedBlocks (`core.byType` / `core.typedBlocks`):
 *   - `typedBlocks.live`      — any block create / soft-delete / restore
 *                               (membership change in the live set)
 *   - `typedBlocks.type`      — block_types index changed for (ws, type)
 *   - `typedBlocks.property`  — a property value changed for (ws, name)
 *   - `typedBlocks.reference` — incoming-edge set changed for (ws, target)
 *   - `typedBlocks.referenceField` — same, sourceField-granular
 *
 *   alias index (`core.aliasLookup` / `core.aliasMatches` /
 *   `core.aliasesInWorkspace`):
 *   - `kernel.aliases`        — block_aliases set changed in (ws) — the
 *                               `alias` property differs across the diff,
 *                               or a row with non-empty aliases entered
 *                               or left the live set
 *
 *   content scans (`core.searchByContent` / `core.recentBlocks`):
 *   - `kernel.content`        — content edited or live-set membership
 *                               changed in (ws). Recent-block ordering
 *                               by `updated_at` is intentionally NOT a
 *                               trigger — bumping recency on every
 *                               UiState property write would put us
 *                               back at the workspace-broad cost.
 *
 * Per-row deps from `hydrateBlocks` already cover updates to rows that
 * are currently in the result; these channels close the gap for rows
 * that *could enter or leave* the result.
 *
 * The rule runs both in the fast tx path (`collectFromSnapshots`) and in
 * the row_events tail (`collectFromRowEvent`) so sync-applied writes
 * fire the same channels.
 */

import type { ChangeSnapshot, InvalidationRule } from '@/data/invalidation.ts'

export const TYPED_BLOCKS_LIVE_CHANNEL = 'typedBlocks.live'
export const TYPED_BLOCKS_TYPE_CHANNEL = 'typedBlocks.type'
export const TYPED_BLOCKS_PROPERTY_CHANNEL = 'typedBlocks.property'
export const TYPED_BLOCKS_REFERENCE_CHANNEL = 'typedBlocks.reference'
export const TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL = 'typedBlocks.referenceField'
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

export const kernelAliasesKey = (workspaceId: string): string => workspaceId
export const kernelContentKey = (workspaceId: string): string => workspaceId

/** Property name that holds the type list. Mirrors `typesProp.name` from
 *  `data/properties.ts`; duplicated here so this module stays free of the
 *  property-schema surface (which transitively pulls in codecs etc.). */
const TYPES_PROPERTY_NAME = 'types'

/** Property name that holds the alias list. Mirrors `aliasesProp.name`
 *  from `data/internals/coreProperties.ts`; duplicated for the same
 *  reason as `TYPES_PROPERTY_NAME`. The kernel `block_aliases` trigger
 *  derives the index from this exact property key — keeping the rule
 *  in sync with the schema. */
const ALIAS_PROPERTY_NAME = 'alias'

/** True iff `properties.alias` decodes to at least one string entry —
 *  exactly the predicate the `block_aliases` triggers use to gate
 *  inserts (`typeof(je.value) = 'text'` in `clientSchema.ts`). The
 *  empty string is intentionally included: the trigger indexes it, so
 *  an alias-keyed query subscribed to `kernel.aliases` must wake when a
 *  row carrying `alias: ['']` enters/leaves the live set or it would
 *  silently miss block_aliases updates. */
const hasAlias = (
  properties: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (!properties) return false
  const raw = properties[ALIAS_PROPERTY_NAME]
  if (!Array.isArray(raw)) return false
  return raw.some(v => typeof v === 'string')
}

const decodeTypes = (
  properties: Readonly<Record<string, unknown>> | undefined,
): readonly string[] => {
  if (!properties) return []
  const raw = properties[TYPES_PROPERTY_NAME]
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is string => typeof t === 'string')
}

const encodedEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

type Emit = (channel: string, key: string) => void

const emitTypeChannel = (
  emit: Emit,
  emitted: Set<string>,
  workspaceId: string,
  type: string,
): void => {
  const key = typedBlocksTypeKey(workspaceId, type)
  if (emitted.has(key)) return
  emitted.add(key)
  emit(TYPED_BLOCKS_TYPE_CHANNEL, key)
}

const emitPropertyChannel = (
  emit: Emit,
  emitted: Set<string>,
  workspaceId: string,
  name: string,
): void => {
  const key = typedBlocksPropertyKey(workspaceId, name)
  if (emitted.has(key)) return
  emitted.add(key)
  emit(TYPED_BLOCKS_PROPERTY_CHANNEL, key)
}

const emitReferenceChannels = (
  emit: Emit,
  emittedTargets: Set<string>,
  emittedFields: Set<string>,
  workspaceId: string,
  targetId: string,
  sourceField: string | undefined,
): void => {
  const targetKey = typedBlocksReferenceKey(workspaceId, targetId)
  if (!emittedTargets.has(targetKey)) {
    emittedTargets.add(targetKey)
    emit(TYPED_BLOCKS_REFERENCE_CHANNEL, targetKey)
  }
  // Field-specific channel keyed by `sourceField ?? ''`. Content refs
  // store as `''` in `block_references.source_field`, and a typed query
  // with `referencedBy: {id, sourceField: ''}` is the "content refs
  // only" filter — narrower than the broad target channel. Skipping
  // `''` here would silently drop those queries on the floor (their
  // dep is on the field channel; `kernelQueries.typedBlocks` doesn't
  // also subscribe to the broad one when `sourceField !== undefined`).
  const normalizedField = sourceField ?? ''
  const fieldKey = typedBlocksReferenceFieldKey(workspaceId, targetId, normalizedField)
  if (!emittedFields.has(fieldKey)) {
    emittedFields.add(fieldKey)
    emit(TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, fieldKey)
  }
}

/** Diff a single ChangeSnapshot and emit every channel this rule owns
 *  (typedBlocks.* + kernel.aliases + kernel.content). Pure — no side
 *  effects beyond `emit`. */
export const emitKernelInvalidations = (
  snapshot: ChangeSnapshot,
  emit: Emit,
): void => {
  const beforeLive = !!snapshot.before && !snapshot.before.deleted
  const afterLive = !!snapshot.after && !snapshot.after.deleted
  const workspaceId = snapshot.after?.workspaceId ?? snapshot.before?.workspaceId
  if (!workspaceId) return

  const emittedTypes = new Set<string>()
  const emittedProps = new Set<string>()
  const emittedRefTargets = new Set<string>()
  const emittedRefFields = new Set<string>()
  let emittedAliases = false
  let emittedContent = false

  const emitAliasesOnce = (): void => {
    if (emittedAliases) return
    emittedAliases = true
    emit(KERNEL_ALIASES_CHANNEL, kernelAliasesKey(workspaceId))
  }
  const emitContentOnce = (): void => {
    if (emittedContent) return
    emittedContent = true
    emit(KERNEL_CONTENT_CHANNEL, kernelContentKey(workspaceId))
  }

  // Liveness change → live channel + emit every axis present on the
  // newly-live (or just-departed) side. A query with no filters subscribes
  // to `live`; queries with filters subscribe to type/property/reference
  // channels matching their filters and pick up the relevant side here.
  if (beforeLive !== afterLive) {
    emit(TYPED_BLOCKS_LIVE_CHANNEL, typedBlocksLiveKey(workspaceId))
    const liveSide = afterLive ? snapshot.after : snapshot.before
    if (liveSide) {
      for (const t of decodeTypes(liveSide.properties)) {
        emitTypeChannel(emit, emittedTypes, workspaceId, t)
      }
      if (liveSide.properties) {
        for (const name of Object.keys(liveSide.properties)) {
          emitPropertyChannel(emit, emittedProps, workspaceId, name)
        }
      }
      if (liveSide.references) {
        for (const ref of liveSide.references) {
          emitReferenceChannels(
            emit,
            emittedRefTargets,
            emittedRefFields,
            workspaceId,
            ref.id,
            ref.sourceField,
          )
        }
      }
      // kernel.content fires on any liveness flip — searchByContent's
      // `content != ''` filter and recentBlocks' result set depend on
      // membership.
      emitContentOnce()
      // kernel.aliases fires only if the live side actually carries an
      // alias — block_aliases is keyed off `properties.alias`, so a
      // restore/tombstone of a row with no aliases doesn't shift the
      // index.
      if (hasAlias(liveSide.properties)) emitAliasesOnce()
    }
    return
  }

  // Both sides dead (e.g. an update on a soft-deleted row): nothing
  // observable to typed-blocks queries — they all skip deleted rows.
  if (!beforeLive || !afterLive) return

  // Both sides live: per-axis diff.
  const beforeTypes = decodeTypes(snapshot.before?.properties)
  const afterTypes = decodeTypes(snapshot.after?.properties)
  if (beforeTypes.length > 0 || afterTypes.length > 0) {
    const beforeTypeSet = new Set(beforeTypes)
    const afterTypeSet = new Set(afterTypes)
    for (const t of beforeTypes) {
      if (!afterTypeSet.has(t)) emitTypeChannel(emit, emittedTypes, workspaceId, t)
    }
    for (const t of afterTypes) {
      if (!beforeTypeSet.has(t)) emitTypeChannel(emit, emittedTypes, workspaceId, t)
    }
  }

  const beforeProps = snapshot.before?.properties ?? {}
  const afterProps = snapshot.after?.properties ?? {}
  // Single pass over the union of keys; encodedEqual rejects only when
  // the encoded JSON differs.
  const seenNames = new Set<string>()
  for (const name of Object.keys(beforeProps)) {
    seenNames.add(name)
    if (!encodedEqual(beforeProps[name], afterProps[name])) {
      emitPropertyChannel(emit, emittedProps, workspaceId, name)
      if (name === ALIAS_PROPERTY_NAME) emitAliasesOnce()
    }
  }
  for (const name of Object.keys(afterProps)) {
    if (seenNames.has(name)) continue
    if (!encodedEqual(beforeProps[name], afterProps[name])) {
      emitPropertyChannel(emit, emittedProps, workspaceId, name)
      if (name === ALIAS_PROPERTY_NAME) emitAliasesOnce()
    }
  }

  // Content diff. ChangeSnapshotSide carries content as an optional
  // top-level field (added alongside this rule). undefined-on-both-sides
  // (rule-test scaffolding without a content key) is treated as "no
  // change" — we only fire when the values actually differ.
  if ((snapshot.before?.content ?? '') !== (snapshot.after?.content ?? '')) {
    emitContentOnce()
  }

  const beforeRefs = snapshot.before?.references ?? []
  const afterRefs = snapshot.after?.references ?? []
  if (beforeRefs.length > 0 || afterRefs.length > 0) {
    const refKey = (r: { id: string; sourceField?: string }): string =>
      `${r.id}${SEP}${r.sourceField ?? ''}`
    const beforeMap = new Map<string, { id: string; sourceField?: string }>()
    for (const r of beforeRefs) beforeMap.set(refKey(r), r)
    const afterMap = new Map<string, { id: string; sourceField?: string }>()
    for (const r of afterRefs) afterMap.set(refKey(r), r)
    for (const [k, r] of beforeMap) {
      if (!afterMap.has(k)) {
        emitReferenceChannels(
          emit,
          emittedRefTargets,
          emittedRefFields,
          workspaceId,
          r.id,
          r.sourceField,
        )
      }
    }
    for (const [k, r] of afterMap) {
      if (!beforeMap.has(k)) {
        emitReferenceChannels(
          emit,
          emittedRefTargets,
          emittedRefFields,
          workspaceId,
          r.id,
          r.sourceField,
        )
      }
    }
  }
}

export const kernelInvalidationRule: InvalidationRule = {
  id: 'core.kernelInvalidation',
  collectFromSnapshots: (snapshots, emit) => {
    for (const snapshot of snapshots.values()) {
      emitKernelInvalidations(snapshot, emit)
    }
  },
  collectFromRowEvent: ({ before, after }, emit) => {
    // Row-event payloads expose the full BlockData; ChangeSnapshot is the
    // slim view a rule needs. The slim shape is structurally compatible
    // — `content` and `properties` ride along under their own names.
    emitKernelInvalidations(
      { before: before as ChangeSnapshot['before'], after: after as ChangeSnapshot['after'] },
      emit,
    )
  },
}
