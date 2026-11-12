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

/** Whether the child listing a block was rendered in shows property rows (its
 *  display mode is not `none`), provided by `BlockChildren`. A context of its
 *  own rather than a `BlockContext` field: a block's `BlockContext` is part of
 *  its renderer's slot identity, so flipping a field there on a mode switch
 *  would remount every child's content; this is read only by the
 *  property-row renderers. Outside any listing (a breadcrumb, a backlink
 *  entry's root) it is `false`. */
export const PropertyRowListingContext = createContext(false)

/** The field row whose value column this is, provided by a field row drawn as
 *  a property row around its own children. */
export const PropertyFieldRowContext = createContext<string | null>(null)
