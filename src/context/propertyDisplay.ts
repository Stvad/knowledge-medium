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

/** The parent whose child listing this is, when that listing shows property
 *  rows (its display mode is not `none`); `null` otherwise. Provided by
 *  `BlockChildren`. A field row is drawn as a row only when it is a child of
 *  this parent, so a block mounted by id inside the listing's subtree — a
 *  backlink entry root, an embed — is never mistaken for one of its rows.
 *  A context of its own rather than a `BlockContext` field: a block's
 *  `BlockContext` is part of its renderer's slot identity, so changing a field
 *  there on a mode switch would remount every child's content. */
export const PropertyRowListingContext = createContext<string | null>(null)

/** The field row whose value column this is, provided by a field row drawn as
 *  a property row around its own children. */
export const PropertyFieldRowContext = createContext<string | null>(null)
