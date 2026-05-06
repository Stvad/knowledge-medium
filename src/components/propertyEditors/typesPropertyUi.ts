import { definePropertyUi } from '@/data/api'
import { propertyUiFacet } from '@/data/facets.ts'
import { typesProp } from '@/data/properties.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { TypesPropertyEditor } from './TypesPropertyEditor'

export const typesPropertyUi = definePropertyUi<readonly string[]>({
  name: typesProp.name,
  label: 'Types',
  category: 'Core',
  Editor: TypesPropertyEditor,
})

export const typesPropertyUiExtension: AppExtension = [
  propertyUiFacet.of(typesPropertyUi, {source: 'kernel-ui'}),
]
