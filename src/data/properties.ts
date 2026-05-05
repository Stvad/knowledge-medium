/**
 * Kernel + UI-state property descriptors. Each export is a
 * `PropertySchema<T>` (data-layer definition with codec + default +
 * change scope + kind). React UI contributions live separately under
 * `propertyUiFacet` (Phase 3). See spec §4.1.1 / §5.6 / §6.
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
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
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
  kind: 'boolean',
})

export const isEditingProp = defineProperty<boolean>('isEditing', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.UiState,
  kind: 'boolean',
})

export const topLevelBlockIdProp = defineProperty<string | undefined>('topLevelBlockId', {
  codec: codecs.optional(codecs.string),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
  kind: 'string',
})

export const focusedBlockIdProp = defineProperty<string | undefined>('focusedBlockId', {
  codec: codecs.optional(codecs.string),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
  kind: 'string',
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
  codec: codecs.optional<EditorSelectionState>(codecs.unsafeIdentity<EditorSelectionState>()),
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
  kind: 'object',
})

export const editorFocusRequestProp = defineProperty<number>('editorFocusRequest', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.UiState,
  kind: 'number',
})

export interface BlockSelectionState {
  selectedBlockIds: string[]
  anchorBlockId: string | null
}

export const selectionStateProp = defineProperty<BlockSelectionState>('blockSelectionState', {
  codec: codecs.unsafeIdentity<BlockSelectionState>(),
  defaultValue: {selectedBlockIds: [], anchorBlockId: null},
  changeScope: ChangeScope.UiState,
  kind: 'object',
})

// ──── Block-content schemas (changeScope: BlockDefault) ────

export const isCollapsedProp = defineProperty<boolean>('system:collapsed', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
  kind: 'boolean',
})

export const typesProp = defineProperty<readonly string[]>('types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
  kind: 'list',
})

export const typeProp = defineProperty<string | undefined>('type', {
  codec: codecs.optional(codecs.string),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

export const rendererProp = defineProperty<string | undefined>('renderer', {
  codec: codecs.optional(codecs.string),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

export const rendererNameProp = defineProperty<string | undefined>('rendererName', {
  codec: codecs.optional(codecs.string),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
})

/** Extension lifecycle — content-scope (a flagged extension stays
 *  disabled across reloads, so writes go to the upload queue). */
export const extensionDisabledProp = defineProperty<boolean>('system:disabled', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
  kind: 'boolean',
})

export const createdAtProp = defineProperty<number | undefined>('createdAt', {
  codec: codecs.optional(codecs.number),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
})

export const sourceBlockIdProp = defineProperty<string | undefined>('sourceBlockId', {
  codec: codecs.optional(codecs.string),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'string',
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

export const setFocusedBlockId = (uiStateBlock: Block, id: string): void => {
  void uiStateBlock.set(focusedBlockIdProp, id)
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
 *  via the schema reference (`block.set(typeProp, ...)` etc.). */
export const KERNEL_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  // UI-state schemas
  showPropertiesProp,
  isEditingProp,
  topLevelBlockIdProp,
  focusedBlockIdProp,
  editorSelection,
  editorFocusRequestProp,
  selectionStateProp,
  // BlockDefault schemas
  isCollapsedProp,
  typesProp,
  typeProp,
  rendererProp,
  rendererNameProp,
  extensionDisabledProp,
  createdAtProp,
  sourceBlockIdProp,
  aliasesProp,
] as ReadonlyArray<PropertySchema<unknown>>
