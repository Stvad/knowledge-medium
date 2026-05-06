import {
  definePropertyUi,
  isBooleanCodec,
  isDateCodec,
  isListCodec,
  isNumberCodec,
  isObjectCodec,
  isRefCodec,
  isRefListCodec,
  isStringCodec,
  type AnyPropertyEditorFallbackContribution,
} from '@/data/api'
import { propertyEditorFallbackFacet, propertyUiFacet } from '@/data/facets.ts'
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

export const typesPropertyUi = definePropertyUi<readonly string[]>({
  name: typesProp.name,
  label: 'Types',
  category: 'Core',
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
].map(schema => definePropertyUi({
  name: schema.name,
  hidden: true,
}))

const kernelPropertyEditorFallbacks: readonly AnyPropertyEditorFallbackContribution[] = [
  {
    id: 'kernel.ref',
    priority: 100,
    matches: schema => isRefCodec(schema.codec),
    Editor: RefPropertyEditor,
  },
  {
    id: 'kernel.refList',
    priority: 100,
    matches: schema => isRefListCodec(schema.codec),
    Editor: RefListPropertyEditor,
  },
  {
    id: 'kernel.boolean',
    priority: 10,
    matches: schema => isBooleanCodec(schema.codec),
    Editor: BooleanPropertyEditor,
  },
  {
    id: 'kernel.date',
    priority: 0,
    matches: schema => isDateCodec(schema.codec),
    Editor: DatePropertyEditor,
  },
  {
    id: 'kernel.list',
    priority: 0,
    matches: schema => isListCodec(schema.codec),
    Editor: ListPropertyEditor,
  },
  {
    id: 'kernel.number',
    priority: 0,
    matches: schema => isNumberCodec(schema.codec),
    Editor: NumberPropertyEditor,
  },
  {
    id: 'kernel.object',
    priority: 0,
    matches: schema => isObjectCodec(schema.codec),
    Editor: ObjectPropertyEditor,
  },
  {
    id: 'kernel.string',
    priority: 0,
    matches: schema => isStringCodec(schema.codec),
    Editor: StringPropertyEditor,
  },
]

export const kernelPropertyUiExtension: AppExtension = [
  propertyUiFacet.of(typesPropertyUi, {source: 'kernel-ui'}),
  hiddenKernelPropertyUis.map(ui => propertyUiFacet.of(ui, {source: 'kernel-ui'})),
  kernelPropertyEditorFallbacks.map(editor => propertyEditorFallbackFacet.of(editor, {source: 'kernel-ui'})),
]

export const typesPropertyUiExtension = kernelPropertyUiExtension
