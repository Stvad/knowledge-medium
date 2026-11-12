import { createContext } from 'react'
import type { PropertyDisplayLevels } from '@/data/propertyDisplayMode'

/** The levels of the property display mode above the block — workspace (and,
 *  later, panel) — provided once per panel by `PropertyDisplayScope`. Outside
 *  one (a dialog, a hover preview) the outline shows no property rows. */
export type PropertyDisplayScopeLevels = Omit<PropertyDisplayLevels, 'block'>

export const NO_PROPERTY_DISPLAY_SCOPE: PropertyDisplayScopeLevels = Object.freeze({
  childBacked: false,
  workspace: 'inherit',
  panel: 'inherit',
})

export const PropertyDisplayScopeContext =
  createContext<PropertyDisplayScopeLevels>(NO_PROPERTY_DISPLAY_SCOPE)
