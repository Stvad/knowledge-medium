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
import { Block } from '@/data/internals/block'
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

export const isCollapsedProp = defineProperty<boolean>('system:collapsed', {
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
 *  controlled and not exposed for plugin extension. */
export interface EditorSelectionState {
  blockId: string
  start?: number
  end?: number
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

export const recentBlockIdsProp = defineProperty<string[]>('recentBlockIds', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.UiState,
  kind: 'list',
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

export const previousLoadTimeProp = defineProperty<number | undefined>('previousLoadTime', {
  codec: codecs.optional(codecs.number),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
})

export const currentLoadTimeProp = defineProperty<number | undefined>('currentLoadTime', {
  codec: codecs.optional(codecs.number),
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  kind: 'number',
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
export { aliasesProp } from '@/data/internals/coreProperties'

// ──── Helpers ────

export const RECENT_BLOCKS_LIMIT = 10

/** Push `blockId` to the front of the recent list (deduped, capped at
 *  RECENT_BLOCKS_LIMIT). Fire-and-forget — UI-state writes don't need
 *  to await. */
export const pushRecentBlockId = (uiStateBlock: Block, blockId: string): void => {
  const current = uiStateBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void uiStateBlock.set(recentBlockIdsProp, next)
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
