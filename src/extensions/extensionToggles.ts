/**
 * Extension-block → togglable decode (app layer).
 *
 * The facet kernel (`@/facets/togglable.ts`) is data-free: its
 * `userToggle({id, name, description})` factory takes display metadata
 * as plain strings. This module is the inverse half — it reads an
 * extension *block*'s properties (name, description, aliases) without
 * compiling the block, then hands the resolved labels to `userToggle`.
 *
 * Keeping this decode here (not in the kernel) is what makes `@/data`
 * able to import `@/facets` one-directionally: the kernel never reaches
 * back into the data layer for property schemas.
 *
 * Display metadata lives on block properties precisely so a disabled
 * extension — which we intentionally never compile — can still be named
 * and described in the settings tree.
 */

import type {BlockData} from '@/data/api'
import {aliasesProp} from '@/data/internals/coreProperties.js'
import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties.js'
import {userToggle, type Togglable} from '@/facets/togglable.js'

/** Decode a string-valued extension property (name/description) from a
 *  block, returning undefined when absent, empty, or malformed. */
function blockStringProperty(
  block: BlockData,
  schema: typeof extensionNameProp | typeof extensionDescriptionProp,
): string | undefined {
  const encoded = block.properties[schema.name]
  if (encoded === undefined) return undefined
  try {
    const value = schema.codec.decode(encoded).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Resolve a display name from block-level data only — no module
 *  compilation. Prefers the explicit `extension:name`, then the first
 *  non-empty alias, then a block-id snippet (rendered as a link in the
 *  settings UI). */
function blockOnlyName(block: BlockData): string {
  const extensionName = blockStringProperty(block, extensionNameProp)
  if (extensionName) return extensionName

  const firstAlias = extensionAliasValues(block).find(alias => alias.trim().length > 0)
  if (firstAlias) return firstAlias

  // Settings UI renders this string as a link to the block.
  return `Extension ${block.id.slice(0, 8)}`
}

/** Every label that identifies this extension block: the explicit
 *  `extension:name` plus any aliases. The agent bridge uses this to
 *  resolve `enable-extension <label>` / `uninstall-extension <label>`
 *  to a block; the settings UI uses `blockOnlyName` (above) for
 *  display. Same input, different projection. */
export function extensionAliasValues(block: BlockData): string[] {
  const aliases = (() => {
    const encoded = block.properties[aliasesProp.name]
    if (encoded === undefined) return [] as string[]
    try {
      return aliasesProp.codec.decode(encoded)
    } catch {
      return [] as string[]
    }
  })()
  const extensionName = blockStringProperty(block, extensionNameProp)
  return extensionName ? [...aliases, extensionName] : aliases
}

/** Build a user-extension togglable from a block: decode the display
 *  metadata, then delegate to the kernel's `userToggle` (which locks
 *  `essential`/`kind` and forces `defaultEnabled: false`). */
export function userExtensionToggle(block: BlockData): Togglable {
  return userToggle({
    id: block.id,
    name: blockOnlyName(block),
    description: blockStringProperty(block, extensionDescriptionProp),
  })
}

/** Disabled-shell variant. Same decode + factory: all metadata is
 *  block-local, so no module compilation is needed. */
export function userExtensionShellToggle(block: BlockData): Togglable {
  return userExtensionToggle(block)
}
