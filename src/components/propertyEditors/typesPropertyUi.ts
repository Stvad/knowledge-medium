import {definePropertyEditorOverride} from '@/data/api'
import { propertyEditorOverridesFacet } from '@/data/facets.js'
import {typesProp} from '@/data/properties.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { TypesPropertyEditor } from './TypesPropertyEditor'

export const typesPropertyUi = definePropertyEditorOverride<readonly string[]>({
  name: typesProp.name,
  label: 'Types',
  Editor: TypesPropertyEditor,
})

/** Per-name editor overrides only — type-keyed editor selection now
 *  flows through the value-preset cores + presentations join
 *  (`readValuePresets`). See user-defined-properties §1-edit. */
export const kernelPropertyUiExtension: AppExtension = systemToggle({
  id: 'system:kernel-property-ui',
  name: 'Property editors',
  description: 'Editor overrides for kernel property definitions.',
}).of([
  propertyEditorOverridesFacet.of(typesPropertyUi, {source: 'kernel-ui'}),
])

export const typesPropertyUiExtension = kernelPropertyUiExtension
