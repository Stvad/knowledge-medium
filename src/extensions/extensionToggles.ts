/**
 * Extension-block → togglable decode (app layer).
 *
 * The facet kernel (`@/facets/togglable.ts`) is data-free: its
 * `userToggle({id, name, description})` factory takes display metadata
 * as plain strings. This module is the inverse half — it reads an
 * extension *block*'s properties (name, description) without compiling
 * the block, then hands the resolved metadata to `userToggle`.
 *
 * Extensions are identified by `extension:name` only. They are
 * deliberately NOT aliased / page-typed: an aliased block whose content
 * is its own source would have that source mirrored into an alias by the
 * content↔alias parity processor (`@/plugins/alias/syncProcessor.ts`).
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
 *  compilation. Uses the explicit `extension:name`, falling back to a
 *  block-id snippet (rendered as a link in the settings UI). Exported so
 *  non-toggle surfaces (the global approval prompts) can label an
 *  extension without constructing a full togglable. */
export function extensionDisplayName(block: BlockData): string {
  const name = extensionName(block)
  if (name) return name

  // Settings UI renders this string as a link to the block.
  return `Extension ${block.id.slice(0, 8)}`
}

/** The label that identifies this extension block: its explicit
 *  `extension:name` (set at install time). The agent bridge uses this to
 *  resolve `enable-extension <name>` / `uninstall-extension <name>` to a
 *  block; the settings UI uses `extensionDisplayName` (above) for display.
 *  Undefined when absent/empty/malformed. */
export function extensionName(block: BlockData): string | undefined {
  return blockStringProperty(block, extensionNameProp)
}

/** Build a user-extension togglable from a block: decode the display
 *  metadata, then delegate to the kernel's `userToggle` (which locks
 *  `essential`/`kind` and forces `defaultEnabled: false`). */
export function userExtensionToggle(block: BlockData): Togglable {
  return userToggle({
    id: block.id,
    name: extensionDisplayName(block),
    description: blockStringProperty(block, extensionDescriptionProp),
  })
}

/** Disabled-shell variant. Same decode + factory: all metadata is
 *  block-local, so no module compilation is needed. */
export function userExtensionShellToggle(block: BlockData): Togglable {
  return userExtensionToggle(block)
}
