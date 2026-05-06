import { definePropertyUi } from '@/data/api'
import { propertyUiFacet } from '@/data/facets.ts'
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

export const kernelPropertyUiExtension: AppExtension = [
  propertyUiFacet.of(typesPropertyUi, {source: 'kernel-ui'}),
  hiddenKernelPropertyUis.map(ui => propertyUiFacet.of(ui, {source: 'kernel-ui'})),
]

export const typesPropertyUiExtension = kernelPropertyUiExtension
