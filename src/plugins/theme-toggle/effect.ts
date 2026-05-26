/*
  Mirrors `themesFacet` contributions into three side effects:

  1. A managed `<style data-theme-plugin-managed>` element on
     document.head receives a `[data-theme="<id>"] { --token: value; ... }`
     block per contribution, so the palette renders the moment the
     attribute is set.
  2. The cycle registry in `theme.ts` is rebuilt to mirror the
     contribution order so toggleTheme() cycles through whatever's
     currently registered.
  3. One "Theme: <label>" `actionsFacet` entry per contribution is
     pushed at runtime so the command palette surfaces an explicit
     picker — selecting an entry applies that theme directly,
     complementing the cycle action.

  No localStorage cache — first paint shows the persisted theme via
  the pre-paint script in index.html; if that theme is plugin-provided,
  the matching rule is injected as soon as this effect runs, which is
  a brief flash to the `:root` (light) fallback. Mirrors the
  keybindings-settings precedent ("First paint shows defaults until
  this effect runs; that's intentional").
*/

import { actionsFacet, type AppEffect } from '@/extensions/core.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import {
  applyTheme,
  FALLBACK_THEME,
  setThemeRegistry,
  themesFacet,
  type ThemeContribution,
  type ThemeDefinition,
} from './theme.ts'

const STYLE_ELEMENT_ATTR = 'data-theme-plugin-managed'

/** Runtime source key for the per-theme apply actions. Held in a
 *  dedicated bucket so push-and-replace keeps the action list in sync
 *  with the facet rather than appending duplicates. */
const APPLY_ACTIONS_SOURCE = 'theme-toggle.apply-actions'

const toDefinition = (c: ThemeContribution): ThemeDefinition => ({
  id: c.id,
  label: c.label,
  mode: c.mode,
})

export const buildThemeRule = (c: ThemeContribution): string => {
  const lines = Object.entries(c.tokens)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n')
  return `[data-theme="${c.id}"] {\n${lines}\n}`
}

export const buildThemeStylesheet = (
  contributions: readonly ThemeContribution[],
): string => contributions.map(buildThemeRule).join('\n\n')

export const buildApplyThemeAction = (
  theme: ThemeContribution,
): ActionConfig<typeof ActionContextTypes.GLOBAL> => ({
  id: `theme-toggle.apply.${theme.id}`,
  description: `Theme: ${theme.label}`,
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    applyTheme(theme.id)
  },
})

export const themeStyleSyncEffect: AppEffect = {
  id: 'theme-toggle.style-sync',
  start: ({ runtime }) => {
    const styleEl = document.createElement('style')
    styleEl.setAttribute(STYLE_ELEMENT_ATTR, '')
    document.head.appendChild(styleEl)

    const apply = (): void => {
      const contributions = runtime.read(themesFacet)
      styleEl.textContent = buildThemeStylesheet(contributions)
      // Facet contributions are authoritative; the cycle order is
      // simply their order. If no plugin contributed, fall back to
      // the bootstrap sentinel so toggleTheme still has somewhere to
      // land (a one-element cycle behaves as a no-op, which is what
      // we want when nobody has defined any themes).
      const definitions: readonly ThemeDefinition[] = contributions.length === 0
        ? [FALLBACK_THEME]
        : contributions.map(toDefinition)
      setThemeRegistry(definitions)
      runtime.setRuntimeContributions(
        actionsFacet,
        APPLY_ACTIONS_SOURCE,
        contributions.map(buildApplyThemeAction),
      )
    }
    apply()

    const unsubscribe = runtime.onFacetChange(themesFacet.id, apply)

    return () => {
      unsubscribe()
      styleEl.remove()
      setThemeRegistry([FALLBACK_THEME])
      // Drop the runtime action bucket so the next effect-start
      // doesn't see stale entries (matches the keybindings-settings
      // dispose pattern).
      runtime.setRuntimeContributions(actionsFacet, APPLY_ACTIONS_SOURCE, [])
    }
  },
}
