/**
 * Shared shapes for the live-presence spike. Presence is *ephemeral*
 * awareness state — it never touches the kernel/`blocks` store. It rides a
 * Supabase Realtime channel (Presence for identity + selection + editor
 * caret; Broadcast for the high-frequency mouse cursor) and lives only in
 * the in-memory `presenceClient` store. See `presenceClient.ts`.
 */

/** Stable per-user identity attached to every presence/cursor payload. */
export interface PresenceIdentity {
  /** Per-installation id (`getClientId()`) — the Realtime presence key, so
   *  two tabs/devices of the same user are distinct cursors. */
  clientId: string
  /** Supabase auth user id (`repo.user.id`). */
  userId: string
  /** Display name (`repo.user.name`). */
  name: string
  /** Deterministic colour derived from `userId`. */
  color: string
}

/** What the local client publishes about itself via Realtime Presence. */
export interface LocalPresence {
  selectedBlockIds: string[]
  anchorBlockId: string | null
  /** The single focused/edited block, so a remote user is visible even when
   *  they have no multi-selection. */
  focusedBlockId: string | null
  /** Live editor caret/selection, mirrored from the kernel `editorSelection`
   *  UI-state property. */
  editor: { blockId: string; start: number | null; end: number | null } | null
}

/** A remote peer's full presence entry (identity + their `LocalPresence`). */
export interface RemotePresence extends PresenceIdentity, LocalPresence {}

/** A remote peer's mouse cursor, anchored to a block + fractional offset so
 *  it lands in the same logical place regardless of the viewer's scroll
 *  position or window width. `blockId === null` means "off any block" → hide. */
export interface RemoteCursor extends PresenceIdentity {
  blockId: string | null
  renderScopeId?: string
  /** Fraction of the block's width/height (0..1). */
  nx: number
  ny: number
}

/** A remote caret to paint inside a CodeMirror editor for one block. */
export interface RemoteCaret {
  clientId: string
  name: string
  color: string
  start: number
  end: number
}
