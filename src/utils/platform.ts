/** iOS (iPhone/iPad) WebKit — where the WebKit-specific input quirks live (the
 *  soft-keyboard deferred-focus bug, and CodeMirror's `browser.ios` key-deferral).
 *  Every iOS browser is WebKit, so all of them share these quirks. Detecting them
 *  is fiddly: `navigator.vendor` reports the BRAND, not the engine — Safari (and
 *  iPad's desktop-class UA) reports `"Apple Computer, Inc."`, while iOS
 *  Chrome/Edge report `"Google Inc."` and iOS Firefox reports `""`. So vendor
 *  alone misses the non-Safari iOS browsers; for those we also accept the
 *  iOS-exclusive UA tokens `CriOS`/`FxiOS`/`EdgiOS` (Chrome-on-Android is
 *  `Chrome/`, never `CriOS/`, so this can't false-positive off iOS).
 *  `maxTouchPoints > 0` is required by both arms: it excludes desktop Safari on
 *  the Mac (Apple vendor, no touchscreen), which has none of these quirks. */
export const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false
  if ((navigator.maxTouchPoints ?? 0) === 0) return false
  return /apple/i.test(navigator.vendor ?? '')
    || /\b(CriOS|FxiOS|EdgiOS)\//.test(navigator.userAgent ?? '')
}

/** Shortcut capture, matching, and display share the primary modifier rule.
 *  Some browsers leave `navigator.platform` empty, so fall back to the user agent. */
export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '')
