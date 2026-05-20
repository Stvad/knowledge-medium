/**
 * Extensions meta-plugin — owns the runtime-toggle overrides
 * map: schema, sub-block, and the subscription effect that keeps
 * the localStorage first-paint cache in sync with PowerSync.
 *
 * The plugin itself must be `essential: true` in `staticAppExtensions`:
 * if disabled, no one would be writing the cache or dispatching
 * refresh, so toggle changes wouldn't take effect.
 */

import type {AppExtension} from '@/extensions/facet.ts'
import {extensionsDataExtension} from './dataExtension.ts'

export const extensionsSettingsPlugin: AppExtension = [
  extensionsDataExtension,
]

export {
  extensionsOverridesProp,
  extensionsPrefsType,
} from './config.ts'
