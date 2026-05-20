/**
 * System Plugins meta-plugin — owns the runtime-toggle overrides
 * map: schema, sub-block, and the subscription effect that keeps
 * the localStorage first-paint cache in sync with PowerSync.
 *
 * The plugin itself must be `essential: true` in `staticAppExtensions`:
 * if disabled, no one would be writing the cache or dispatching
 * refresh, so toggle changes wouldn't take effect.
 */

import type {AppExtension} from '@/extensions/facet.ts'
import {systemPluginsDataExtension} from './dataExtension.ts'

export const systemPluginsPlugin: AppExtension = [
  systemPluginsDataExtension,
]

export {
  systemPluginOverridesProp,
  systemPluginsPrefsType,
} from './config.ts'
