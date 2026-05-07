import {
  definePropertyEditorOverride,
  type AnyPropertyEditorFallbackContribution,
} from '@/data/api'
import { propertyEditorFallbackFacet, propertyEditorOverridesFacet } from '@/data/facets.ts'
import {
  createdAtProp,
  editorFocusRequestProp,
  editorSelection,
  extensionDisabledProp,
  focusedBlockIdProp,
  isCollapsedProp,
  isEditingProp,
  rendererNameProp,
  rendererProp,
  selectionStateProp,
  showPropertiesProp,
  sourceBlockIdProp,
  topLevelBlockIdProp,
  typesProp,
} from '@/data/properties.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  BooleanPropertyEditor,
  DatePropertyEditor,
  ListPropertyEditor,
  NumberPropertyEditor,
  ObjectPropertyEditor,
  StringPropertyEditor,
} from './defaults'
import { RefListPropertyEditor, RefPropertyEditor } from './RefPropertyEditor'
import { TypesPropertyEditor } from './TypesPropertyEditor'

export const typesPropertyUi = definePropertyEditorOverride<readonly string[]>({
  name: typesProp.name,
  label: 'Types',
  Editor: TypesPropertyEditor,
})

const hiddenKernelPropertyUis = [
  createdAtProp,
  editorFocusRequestProp,
  editorSelection,
  extensionDisabledProp,
  focusedBlockIdProp,
  isCollapsedProp,
  isEditingProp,
  rendererNameProp,
  rendererProp,
  selectionStateProp,
  showPropertiesProp,
  sourceBlockIdProp,
  topLevelBlockIdProp,
].map(schema => definePropertyEditorOverride({
  name: schema.name,
  hidden: true,
}))

/** Codec-type → fallback editor mapping. With the open `type` string
 *  replacing the closed `CodecShape` enum, predicate-based matching
 *  collapses to a literal type comparison; an unknown plugin type
 *  with no entry here falls through to the unknown-schema path
 *  (per user-defined-properties §1-edit). The Phase 2c migration
 *  moves these contributions onto presets via `valuePresetsFacet`. */
const kernelPropertyEditorFallbacks: readonly AnyPropertyEditorFallbackContribution[] = [
  {
    id: 'kernel.ref',
    priority: 100,
    matches: schema => schema.codec.type === 'ref',
    Editor: RefPropertyEditor,
  },
  {
    id: 'kernel.refList',
    priority: 100,
    matches: schema => schema.codec.type === 'refList',
    Editor: RefListPropertyEditor,
  },
  {
    id: 'kernel.boolean',
    priority: 10,
    matches: schema => schema.codec.type === 'boolean',
    Editor: BooleanPropertyEditor,
  },
  {
    id: 'kernel.date',
    priority: 0,
    matches: schema => schema.codec.type === 'date',
    Editor: DatePropertyEditor,
  },
  {
    id: 'kernel.list',
    priority: 0,
    matches: schema => schema.codec.type === 'list',
    Editor: ListPropertyEditor,
  },
  {
    id: 'kernel.number',
    priority: 0,
    matches: schema => schema.codec.type === 'number',
    Editor: NumberPropertyEditor,
  },
  {
    id: 'kernel.object',
    priority: 0,
    matches: schema => schema.codec.type === 'object',
    Editor: ObjectPropertyEditor,
  },
  {
    id: 'kernel.string',
    priority: 0,
    matches: schema => schema.codec.type === 'string',
    Editor: StringPropertyEditor,
  },
]

export const kernelPropertyUiExtension: AppExtension = [
  propertyEditorOverridesFacet.of(typesPropertyUi, {source: 'kernel-ui'}),
  hiddenKernelPropertyUis.map(ui => propertyEditorOverridesFacet.of(ui, {source: 'kernel-ui'})),
  kernelPropertyEditorFallbacks.map(editor => propertyEditorFallbackFacet.of(editor, {source: 'kernel-ui'})),
]

export const typesPropertyUiExtension = kernelPropertyUiExtension
