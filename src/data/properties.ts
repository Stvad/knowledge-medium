/**
 * Kernel + UI-state property descriptors. Each export is a
 * `PropertySchema<T>` (data-layer definition with codec + default +
 * change scope). Per-name editor overrides for the rare property that
 * needs one live separately under `propertyEditorOverridesFacet`
 * (Phase 3). See spec §4.1.1 / §5.6 / §6.
 *
 * Migration note (1.6): legacy creator helpers (`stringProperty`,
 * `boolProp`, `objectProperty`, etc.) returned a record-shape
 * `{name, type, value}` that doubled as schema AND value. The new
 * shape is flat — `block.set(schema, value)` / `block.get(schema)`
 * encode/decode through the codec; storage holds the encoded value
 * directly. Helpers like `aliasProp(['x','y'])` (which embedded a
 * default value into the descriptor) are gone — the schema's
 * `defaultValue` is the single source of truth, callers pass values
 * via `block.set(schema, value)`.
 */
import type { Block } from './block'
import type { BlockData, ChangedRow } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { propertyFieldIdProp } from '@/data/propertyChildren'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type PropertySchema,
} from '@/data/api'

// ──── UI-state schemas (changeScope: UiState) ────

export const showPropertiesProp = defineProperty<boolean>('system:showProperties', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UiState,
})

export const isEditingProp = defineProperty<boolean>('isEditing', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UiState,
})

export const topLevelBlockIdProp = defineProperty<string | undefined>('topLevelBlockId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const focusedBlockIdProp = defineProperty<string | undefined>('focusedBlockId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const focusedVisualTargetKeyProp = defineProperty<string | undefined>('focusedVisualTargetKey', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const activePanelIdProp = defineProperty<string | undefined>('activePanelId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const scrollTopProp = defineProperty<number | undefined>('scrollTop', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

/** Editor-selection state for the active block. Object-typed; the
 *  `unsafeIdentity` codec is appropriate because the shape is engine-
 *  controlled and not exposed for plugin extension. The optional
 *  `line` / `x` / `y` fields are placement hints used by CodeMirror's
 *  cursor-restoration helpers — start/end are the linear offsets,
 *  x/y are pixel coordinates for visual restoration after a wrap. */
export interface EditorSelectionState {
  blockId: string
  start?: number
  end?: number
  line?: 'first' | 'last'
  x?: number
  y?: number
}

export const editorSelection = defineProperty<EditorSelectionState | undefined>('editorSelection', {
  codec: codecs.optionalIdentity<EditorSelectionState>(),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})

export const editorFocusRequestProp = defineProperty<number>('editorFocusRequest', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.UiState,
})

export interface BlockSelectionState {
  selectedBlockIds: string[]
  anchorBlockId: string | null
}

export const selectionStateProp = defineProperty<BlockSelectionState>('blockSelectionState', {
  codec: codecs.unsafeIdentity<BlockSelectionState>(),
  defaultValue: {selectedBlockIds: [], anchorBlockId: null},
  changeScope: ChangeScope.UiState,
})

// ──── Block-content schemas (changeScope: BlockDefault) ────

export const isCollapsedProp = defineProperty<boolean>('system:collapsed', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const typesProp = defineProperty<readonly string[]>('types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

export const rendererProp = defineProperty<string | undefined>('renderer', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const rendererNameProp = defineProperty<string | undefined>('rendererName', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const createdAtProp = defineProperty<number | undefined>('createdAt', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const sourceBlockIdProp = defineProperty<string | undefined>('sourceBlockId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// ──── extension block fields ────

/** Human-readable extension name. Kept on the block instead of inside
 *  executable extension code so disabled extensions can still be
 *  described in settings without compiling them. */
export const extensionNameProp = defineProperty<string>('extension:name', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional extension description displayed in the settings surface. */
export const extensionDescriptionProp = defineProperty<string>('extension:description', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// ──── property-schema kernel type fields (user-defined-properties §4) ────

/** User-supplied property name on a `'property-schema'` block. */
export const propertyNameProp = defineProperty<string>('property-schema:name', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Preset id on a `'property-schema'` block — matches a registered
 *  `ValuePreset.id` (and the codec's `type` for codecs built by that
 *  preset). */
export const presetIdProp = defineProperty<string>('property-schema:preset', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Preset-specific config JSON. Stored as opaque JSON via the
 *  `unsafeIdentity` codec; validation happens in the preset's
 *  `configCodec.decode` at registration time. */
export const presetConfigProp = defineProperty<Record<string, unknown>>('property-schema:config', {
  codec: codecs.unsafeIdentity<Record<string, unknown>>('object'),
  defaultValue: {},
  changeScope: ChangeScope.BlockDefault,
})

// ──── block-type kernel fields (user-defined-types Phase 1) ────

/** Human-readable label on a `'block-type'` block. Shown in the type
 *  picker and as the section header in the property panel. */
export const blockTypeLabelProp = defineProperty<string>('block-type:label', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional free-form description on a `'block-type'` block. */
export const blockTypeDescriptionProp = defineProperty<string>('block-type:description', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** RefList over `'property-schema'` blocks. UserTypesService resolves
 *  each ref to the merged property-schema map (via
 *  `UserSchemasService.getSchemaForBlockId`) to build the lifted
 *  property list on the resulting TypeContribution. */
export const blockTypePropertiesProp = defineProperty<readonly string[]>('block-type:properties', {
  codec: codecs.refList({targetTypes: ['property-schema']}),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

/** Re-export of the canonical alias schema (defined under
 *  `@/data/internals/coreProperties.ts` so the kernel parseReferences
 *  processor can reference it without circling back through this
 *  module). Kept here so call-site migrations can import every
 *  descriptor from a single path. */
export { aliasesProp }

// ──── Helpers ────

export const getBlockTypes = (data: Pick<BlockData, 'properties'>): readonly string[] => {
  const raw = data.properties[typesProp.name]
  return raw === undefined ? typesProp.defaultValue : typesProp.codec.decode(raw)
}

export const hasBlockType = (
  data: Pick<BlockData, 'properties'>,
  typeId: string,
): boolean => getBlockTypes(data).includes(typeId)

/** Type-membership delta helpers for same-tx processors that watch the
 *  `properties` field. `row.before` is null on insert; `row.after` is
 *  null on hard-delete — both are null-safe here, returning the
 *  appropriate one-sided diff. Order in the returned array matches
 *  `typesProp.codec.decode` order on whichever side is non-null. */
export const addedTypes = (row: ChangedRow): readonly string[] => {
  const before = row.before ? new Set(getBlockTypes(row.before)) : new Set<string>()
  const after = row.after ? getBlockTypes(row.after) : []
  return after.filter(t => !before.has(t))
}

export const removedTypes = (row: ChangedRow): readonly string[] => {
  const before = row.before ? getBlockTypes(row.before) : []
  const after = row.after ? new Set(getBlockTypes(row.after)) : new Set<string>()
  return before.filter(t => !after.has(t))
}

/** Raw membership writer for BlockData construction paths that do not
 *  have a Repo/Tx available. Does not run setup or materialise
 *  addType initial values. */
export const addBlockTypeToProperties = (
  properties: Record<string, unknown>,
  typeId: string,
): Record<string, unknown> => {
  const current = getBlockTypes({properties})
  if (current.includes(typeId)) return properties
  return {
    ...properties,
    [typesProp.name]: typesProp.codec.encode([...current, typeId]),
  }
}

/** Set the editing flag on the UI-state block. Refuses to enter edit
 *  mode in a read-only repo (workspace viewer) — the wrappers also
 *  short-circuit, but this gate keeps any new caller honest. */
export const setIsEditing = (uiStateBlock: Block, editing: boolean): void => {
  if (editing && uiStateBlock.repo.isReadOnly) return
  void uiStateBlock.set(isEditingProp, editing)
}

/** Atomically move focus to `blockId` and set the edit flag in one tx.
 *
 *  `useInEditMode(blockId)` is `focusedBlockId === blockId && isEditing`,
 *  so the pair behaves as one state — writing focus alone makes the
 *  newly-focused block inherit the previous holder's editing flag, and
 *  `vimNormalModeActivation` declines to put a block into NORMAL_MODE
 *  while its `inEditMode` is true. This is the single primitive for
 *  changing what block has focus: callers pass `{edit: true}` when they
 *  want the new block in edit mode (cm navigation, vim's `o`, etc.)
 *  and omit it (default `false`) to land on the block out of edit mode.
 *
 *  Returns the tx-commit promise so callers that need to observe
 *  focus-derived state next can `await` instead of racing propagation. */
export const focusBlock = async (
  uiStateBlock: Block,
  blockId: string,
  options: {edit?: boolean} = {},
): Promise<void> => {
  const {edit = false} = options
  // Match the legacy `setIsEditing` read-only gate: a viewer can't
  // transition into edit mode, but it can still mark focus (highlight,
  // nav anchor).
  const targetEdit = edit && !uiStateBlock.repo.isReadOnly ? true : false
  await uiStateBlock.repo.tx(async tx => {
    await tx.setProperty(uiStateBlock.id, focusedBlockIdProp, blockId)
    await tx.setProperty(uiStateBlock.id, isEditingProp, targetEdit)
  }, {scope: ChangeScope.UiState, description: 'focus block'})
}

export const focusVisualTarget = async (
  uiStateBlock: Block,
  blockId: string,
  visualTargetKey: string,
  options: {edit?: boolean} = {},
): Promise<void> => {
  const {edit = false} = options
  const targetEdit = edit && !uiStateBlock.repo.isReadOnly ? true : false
  await uiStateBlock.repo.tx(async tx => {
    await tx.setProperty(uiStateBlock.id, focusedBlockIdProp, blockId)
    await tx.setProperty(uiStateBlock.id, focusedVisualTargetKeyProp, visualTargetKey)
    await tx.setProperty(uiStateBlock.id, isEditingProp, targetEdit)
  }, {scope: ChangeScope.UiState, description: 'focus visual target'})
}

export const requestEditorFocus = (uiStateBlock: Block): void => {
  const current = uiStateBlock.peekProperty(editorFocusRequestProp) ?? 0
  void uiStateBlock.set(editorFocusRequestProp, current + 1)
}

// Re-export PropertySchema for callers who want to type-narrow.
export type { PropertySchema }

// ──── Kernel bundle ────

/** Every kernel-owned `PropertySchema` in one array. Consumed by
 *  `kernelDataExtension` to register them with `propertySchemasFacet`
 *  so non-React surfaces (the property panel's schema lookup, future
 *  CLI / server-side audit, plugin authors inspecting the registry)
 *  see the kernel descriptors uniformly.
 *
 *  Heterogeneous `PropertySchema<T>` shapes flatten through
 *  `PropertySchema<unknown>` for storage in the array — the precise
 *  per-schema types stay at the export sites and reach typed callers
 *  via the schema reference (`block.set(typesProp, ...)` etc.). */
export const KERNEL_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  // UI-state schemas
  showPropertiesProp,
  isEditingProp,
  topLevelBlockIdProp,
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
  activePanelIdProp,
  scrollTopProp,
  editorSelection,
  editorFocusRequestProp,
  selectionStateProp,
  // BlockDefault schemas
  isCollapsedProp,
  typesProp,
  rendererProp,
  rendererNameProp,
  createdAtProp,
  sourceBlockIdProp,
  aliasesProp,
  propertyFieldIdProp,
  // extension block fields
  extensionNameProp,
  extensionDescriptionProp,
  // property-schema fields
  propertyNameProp,
  presetIdProp,
  presetConfigProp,
  // block-type fields
  blockTypeLabelProp,
  blockTypeDescriptionProp,
  blockTypePropertiesProp,
] as ReadonlyArray<PropertySchema<unknown>>
