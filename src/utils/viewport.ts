/** The mobile/desktop breakpoint every viewport check in the app shares — one
 *  constant so `useIsMobile` (the React hook, `react.tsx`) and the imperative
 *  reads below can never drift on the pixel value. */
export const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)'

/** Synchronous, non-React viewport read for call sites that can't use a hook:
 *  a gesture recognizer's `isEnabled` fires from the continuous-gesture
 *  loop's imperative per-event dispatch, and the global-command navigation
 *  policy resolves synchronously outside any render — neither can call
 *  `useIsMobile`. (See `continuousGestures.ts`'s `desiredTouchAction` comment
 *  for why the loop can't just read the hook's value from a child render
 *  either — enablement is re-derived per gesture event, not per React
 *  commit.) Guards `window`/`matchMedia` so it degrades to `false` rather
 *  than throwing in a non-DOM environment (SSR / a minimal test harness). */
export const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
