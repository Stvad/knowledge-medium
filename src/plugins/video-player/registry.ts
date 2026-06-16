/**
 * Typed per-(render-scope, block) registry of imperative video-player
 * handles. Replaces the old `window.CustomEvent` request/response bus:
 * each mounted player registers a handle keyed by its block id and
 * render scope, and callers (timestamp links, video actions) look it up
 * and call methods synchronously — no `respond()` callbacks threaded
 * through event detail.
 *
 * The same video block can be rendered in more than one panel/render
 * scope at once, so the key is `(renderScopeId, blockId)`. Callers that
 * know their render scope (actions via `deps.renderScopeId`, timestamp
 * links via `blockContext`) resolve the player in their own panel;
 * callers without a scope (or whose scope has no player) fall back to
 * any registered instance for the block.
 */

export interface VideoPlayerHandle {
  /** Current playback time in seconds, or undefined if the media isn't ready. */
  getCurrentTime(): number | undefined
  /** Move focus to the player; returns whether a focus target existed. */
  focus(): boolean
  /** Whether the player (or its shadow content) currently holds focus. */
  hasFocus(): boolean
  /** Seek to `seconds` and start playback. */
  seekTo(seconds: number): void
}

const SCOPELESS = ''

// blockId -> (renderScopeId -> handle). Nested so we can resolve the
// instance in a specific render scope, then fall back to any instance.
const registry = new Map<string, Map<string, VideoPlayerHandle>>()

export const registerVideoPlayer = (
  blockId: string,
  renderScopeId: string | undefined,
  handle: VideoPlayerHandle,
): (() => void) => {
  const scopeKey = renderScopeId ?? SCOPELESS
  let byScope = registry.get(blockId)
  if (!byScope) {
    byScope = new Map()
    registry.set(blockId, byScope)
  }
  byScope.set(scopeKey, handle)
  return () => {
    const current = registry.get(blockId)
    if (!current) return
    // Guard against clobbering a newer registration under the same key
    // (e.g. a remount before the old cleanup runs).
    if (current.get(scopeKey) === handle) current.delete(scopeKey)
    if (current.size === 0) registry.delete(blockId)
  }
}

const resolveVideoPlayer = (
  blockId: string,
  renderScopeId?: string,
): VideoPlayerHandle | undefined => {
  const byScope = registry.get(blockId)
  if (!byScope) return undefined
  if (renderScopeId !== undefined) {
    const scoped = byScope.get(renderScopeId)
    if (scoped) return scoped
  }
  // No render scope given, or no player in that scope — fall back to any
  // registered instance (single-panel is the common case, and a
  // scopeless caller has no better target).
  return byScope.values().next().value
}

export const requestCurrentTime = (
  blockId: string,
  renderScopeId?: string,
): number | undefined => resolveVideoPlayer(blockId, renderScopeId)?.getCurrentTime()

export const requestVideoPlayerFocus = (
  blockId: string,
  renderScopeId?: string,
): boolean => resolveVideoPlayer(blockId, renderScopeId)?.focus() ?? false

export const isVideoPlayerFocusActive = (
  blockId: string,
  renderScopeId?: string,
): boolean => resolveVideoPlayer(blockId, renderScopeId)?.hasFocus() ?? false

export const seekTo = (
  seconds: number,
  blockId: string,
  renderScopeId?: string,
): void => resolveVideoPlayer(blockId, renderScopeId)?.seekTo(seconds)
