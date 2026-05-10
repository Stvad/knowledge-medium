import { defineBlockType, type TypeContribution } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties'

export const EXTENSION_TYPE = 'extension'
export const PAGE_TYPE = 'page'
export const PANEL_TYPE = 'panel'
export const PANEL_STACK_TYPE = 'panel-stack'
export const DAILY_NOTE_TYPE = 'daily-note'
/** User-defined property schemas live as blocks of this type
 *  (user-defined-properties §4). Kernel-owned; users don't create or
 *  remove the type contribution itself. */
export const PROPERTY_SCHEMA_TYPE = 'property-schema'
/** Marker type for the singleton Properties page that hosts every
 *  property-schema block in a workspace. */
export const PROPERTIES_PAGE_TYPE = 'panel:properties'

export const KERNEL_TYPE_CONTRIBUTIONS: readonly TypeContribution[] = [
  defineBlockType({id: EXTENSION_TYPE, label: 'Extension'}),
  defineBlockType({id: PAGE_TYPE, label: 'Page', properties: [aliasesProp]}),
  defineBlockType({id: PANEL_TYPE, label: 'Panel'}),
  defineBlockType({id: PANEL_STACK_TYPE, label: 'Panel stack'}),
  defineBlockType({id: DAILY_NOTE_TYPE, label: 'Daily note', properties: [aliasesProp]}),
  defineBlockType({
    id: PROPERTY_SCHEMA_TYPE,
    label: 'Property schema',
    // Lift these so addType('property-schema') auto-materialises them
    // and the panel surfaces them through the type-section path.
    properties: [propertyNameProp, presetIdProp, presetConfigProp],
  }),
  defineBlockType({
    id: PROPERTIES_PAGE_TYPE,
    label: 'Properties page',
    properties: [aliasesProp],
  }),
]
