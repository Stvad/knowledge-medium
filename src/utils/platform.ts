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

/** True on macOS/iOS — the single platform-Mac check shared by the
 *  $mod-vs-Ctrl primary-modifier resolution (`canonicalizeChord.ts`,
 *  `keyCapture.ts`) and the Mac-glyph header hints (quick-find /
 *  find-replace / command-palette). `navigator.platform` is deprecated and
 *  can be EMPTY on some browsers, so this also falls back to
 *  `navigator.userAgent` — a strict widening vs. the plain
 *  `navigator.platform`-only regex some call sites used to run on their
 *  own: it can only newly report Mac on inputs the platform-only check used
 *  to miss (empty `navigator.platform`), never flip a real non-Mac platform
 *  to Mac. That "only newly report Mac on empty inputs" framing holds for
 *  `keyCapture.ts`'s prior `Mac|iPod|iPhone|iPad` regex, but NOT for the
 *  three HeaderItems: they previously ran a narrower
 *  `navigator.platform.toLowerCase().includes('mac')` check with no
 *  iPhone/iPad handling at all, so consolidating onto this shared helper is
 *  a real, consumer-visible behavior change for them — their ⌘-vs-Ctrl+
 *  hint now shows ⌘ on iPhone/iPad, which agrees with
 *  `canonicalizeChord.ts`'s `$mod` resolution instead of disagreeing with
 *  it. */
export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '')
