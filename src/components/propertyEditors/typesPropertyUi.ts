import {
  definePropertyEditorOverride,
} from '@/data/api'
import { propertyEditorOverridesFacet } from '@/data/facets.js'
import {
  createdAtProp,
  editorFocusRequestProp,
  editorSelection,
  focusedBlockLocationProp,
  isCollapsedProp,
  isEditingProp,
  presetConfigProp,
  rendererNameProp,
  rendererProp,
  selectionStateProp,
  showPropertiesProp,
  sourceBlockIdProp,
  topLevelBlockIdProp,
  typesProp,
} from '@/data/properties.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
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
  focusedBlockLocationProp,
  isCollapsedProp,
  isEditingProp,
  // Schema-block config is edited through the property-schema block
  // renderer (§4a), not the property panel.
  presetConfigProp,
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

/** Per-name editor overrides only — type-keyed editor selection now
 *  flows through `valuePresetsFacet`. See user-defined-properties §1-edit. */
export const kernelPropertyUiExtension: AppExtension = systemToggle({
  id: 'system:kernel-property-ui',
  name: 'Property editors',
  description: 'Editors for kernel property schemas (types, etc) and the hidden-property list for the property panel.',
}).of([
  propertyEditorOverridesFacet.of(typesPropertyUi, {source: 'kernel-ui'}),
  hiddenKernelPropertyUis.map(ui => propertyEditorOverridesFacet.of(ui, {source: 'kernel-ui'})),
])

export const typesPropertyUiExtension = kernelPropertyUiExtension
