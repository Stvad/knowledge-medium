/**
 * Keybinding overrides — first-class extension point for rebinding
 * actions without forking their definitions.
 *
 * Sources contribute `KeybindingOverride` entries via
 * `keybindingOverridesFacet`. The keybindings-settings plugin
 * contributes one entry per user-remapped action at high precedence;
 * other plugins (or static config) can contribute entries at default
 * precedence to ship opinionated rebinds. A single wildcard
 * `ActionDecorator` (see `applyKeybindingOverrides`) consumes the
 * facet and rewrites each action's `defaultBinding` accordingly.
 *
 * Collision rule (matches "user override wins, default loses"):
 *
 *   • If a user-source override sets action B's chord to ⌘K, and
 *     action A's *default* binding is ⌘K, A's chord is stripped in
 *     contexts that overlap with B's. A still exists; it just no
 *     longer claims that chord.
 *   • Two user-source overrides on the same chord both keep it.
 *     That's the "shadow + warn" case the settings UI surfaces;
 *     hotkeys-js will dispatch both handlers.
 */
import { defineFacet } from '@/extensions/facet.js'
import type { ActionContextType, KeyCombination } from '@/shortcuts/types.js'

export interface KeyOverrideBound {
  readonly keys: KeyCombination | readonly KeyCombination[]
}

export interface KeyOverrideUnbound {
  readonly unbound: true
}

export type KeyOverrideBinding = KeyOverrideBound | KeyOverrideUnbound

export const KEYBINDING_OVERRIDE_USER_SOURCE = 'user-prefs'

export interface KeybindingOverride {
  /** Action id this entry targets. Wildcards are not supported here —
   *  every override is a deliberate per-action statement. */
  readonly actionId: string
  /** Optional narrow to a single context. Omit to apply in whichever
   *  context the action declares. */
  readonly context?: ActionContextType
  readonly binding: KeyOverrideBinding
  /** Identifies the contributor so the decorator can apply the
   *  "user-override wins over default" rule. `'user-prefs'` for the
   *  settings plugin's contributions; plugin id otherwise. */
  readonly source: string
}

export const isKeyOverrideUnbound = (
  binding: KeyOverrideBinding,
): binding is KeyOverrideUnbound => 'unbound' in binding && binding.unbound === true

const isStringOrStringArray = (value: unknown): value is string | readonly string[] =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(item => typeof item === 'string'))

const isKeyOverrideBinding = (value: unknown): value is KeyOverrideBinding => {
  if (typeof value !== 'object' || value === null) return false
  if ('unbound' in value) return (value as KeyOverrideUnbound).unbound === true
  if ('keys' in value) return isStringOrStringArray((value as KeyOverrideBound).keys)
  return false
}

export const isKeybindingOverride = (value: unknown): value is KeybindingOverride => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<KeybindingOverride>
  return typeof v.actionId === 'string'
    && v.actionId.length > 0
    && (v.context === undefined || (typeof v.context === 'string' && v.context.length > 0))
    && typeof v.source === 'string'
    && v.source.length > 0
    && v.binding !== undefined
    && isKeyOverrideBinding(v.binding)
}

export const keybindingOverridesFacet = defineFacet<KeybindingOverride, readonly KeybindingOverride[]>({
  id: 'core.keybinding-overrides',
  validate: isKeybindingOverride,
})
