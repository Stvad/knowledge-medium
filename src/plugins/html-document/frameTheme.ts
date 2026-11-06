/** The app's theme, as CSS a frame can apply. A frame inherits nothing from the
 *  app, and custom properties can't be enumerated off a computed style, hence
 *  the list. Names and values match the app's own, so a document writes
 *  `hsl(var(--primary))` exactly as app CSS does. */

import {useSyncExternalStore} from 'react'

const THEME_TOKENS = [
  'background', 'foreground',
  'card', 'card-foreground',
  'popover', 'popover-foreground',
  'primary', 'primary-foreground',
  'secondary', 'secondary-foreground',
  'muted', 'muted-foreground',
  'accent', 'accent-foreground',
  'destructive', 'destructive-foreground',
  'border', 'input', 'ring',
  'link', 'wikilink', 'code', 'success',
  'radius',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
]

/** `color-scheme` must match the app's or the browser paints the frame's canvas
 *  opaque. Both documents get this, so it holds at both frame boundaries. */
export const readFrameThemeCss = (root: HTMLElement = document.documentElement): string => {
  const style = getComputedStyle(root)
  const tokens = THEME_TOKENS
    .map(name => `--${name}:${style.getPropertyValue(`--${name}`).trim()};`)
    .join('')
  return `:root{color-scheme:${style.colorScheme};${tokens}}` +
    `body{color:hsl(var(--foreground));font-family:${style.fontFamily}}`
}

const subscribeToThemeChanges = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-theme-mode']})
  return () => observer.disconnect()
}

/** A theme change rebuilds the frame's document, so a running document restarts. */
export const useFrameThemeCss = (): string =>
  useSyncExternalStore(subscribeToThemeChanges, readFrameThemeCss)
