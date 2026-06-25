/**
 * The presence transport — a single module-level store that owns one
 * Supabase Realtime channel per workspace and exposes the remote state to
 * React (`hooks.ts`) and to the CodeMirror caret extension.
 *
 * Design (see docs note in the PR):
 *  - Presence is EPHEMERAL. Nothing here writes to the kernel / `blocks`
 *    table / PowerSync. A cursor moving 20×/s must never become a row write.
 *  - Two Realtime primitives for two update rates:
 *      • Presence (`track`)     — identity + selected blocks + editor caret.
 *        Auto-expires on disconnect; low frequency.
 *      • Broadcast (`cursor`)   — the mouse cursor. Cheap, fire-and-forget,
 *        throttled to ~50ms.
 *  - Two notification lanes so a 50ms cursor stream doesn't re-run the
 *    selection decorators / editor caret recompute: `subscribePresence`
 *    (selection + caret) vs `subscribeCursors` (overlay only).
 *
 * Local-only mode (`supabase === null`) and SSR/tests: `connect()` no-ops,
 * the store stays empty, and every consumer degrades to "no peers".
 *
 * SECURITY / PRIVACY (spike caveats, see PR):
 *  - The channel is currently PUBLIC. Hardening = Supabase Realtime
 *    Authorization (private channel + an RLS policy on `realtime.messages`
 *    gating join on `workspace_members`). We `setAuth` the user JWT here so
 *    that switch is forward-compatible.
 *  - For e2ee workspaces this leaks block ids + caret offsets (metadata, not
 *    content) to the Realtime server. Encrypt the payload with the workspace
 *    key, or gate the feature off for e2ee, before shipping on-by-default.
 */
import { throttle } from 'lodash-es'
import { v4 as uuidv4 } from 'uuid'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, readPersistedSession } from '@/services/supabase.js'
import { getClientId } from '@/utils/clientId.js'
import { CallbackSet } from '@/utils/callbackSet.js'
import { colorForUser } from './colors.js'
import type {
  LocalPresence,
  PresenceIdentity,
  RemoteCaret,
  RemoteCursor,
  RemotePresence,
} from './types.js'

const TRACK_THROTTLE_MS = 120
const CURSOR_THROTTLE_MS = 50

const EMPTY_LOCAL: LocalPresence = {
  selectedBlockIds: [],
  anchorBlockId: null,
  focusedBlockId: null,
  editor: null,
}

// Per-TAB identity. `getClientId()` is per browser installation, so two
// tabs/windows in the same profile would share a Realtime presence key —
// collapsing into one peer and dropping each other's cursors. Append a
// per-load nonce so each tab is a distinct presence (the install id stays as
// a readable prefix).
const sessionClientId = `${getClientId()}:${uuidv4()}`

// ── untrusted-input normalisation ──────────────────────────────────────────
// Presence metas and broadcast payloads are arbitrary JSON from other clients
// (and the channel is public while opt-in). Coerce every field to its expected
// shape so a malformed peer payload can't throw and break presence for the
// whole channel. Never throws.

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const asFiniteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asFinite = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

const normalizeEditor = (v: unknown): LocalPresence['editor'] => {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  if (typeof e.blockId !== 'string') return null
  return { blockId: e.blockId, start: asFiniteOrNull(e.start), end: asFiniteOrNull(e.end) }
}

const normalizePresence = (clientId: string, raw: unknown): RemotePresence | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const userId = asString(r.userId)
  return {
    clientId, // the Realtime presence key is authoritative, not the wire value
    userId,
    name: typeof r.name === 'string' && r.name ? r.name : (userId || clientId),
    color: colorForUser(userId), // derive locally — never trust wire colour
    selectedBlockIds: asStringArray(r.selectedBlockIds),
    anchorBlockId: asStringOrNull(r.anchorBlockId),
    focusedBlockId: asStringOrNull(r.focusedBlockId),
    editor: normalizeEditor(r.editor),
  }
}

const normalizeCursor = (raw: unknown): RemoteCursor | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.clientId !== 'string') return null
  const userId = asString(r.userId)
  return {
    clientId: r.clientId,
    userId,
    name: typeof r.name === 'string' ? r.name : userId,
    color: colorForUser(userId),
    blockId: asStringOrNull(r.blockId),
    renderScopeId: typeof r.renderScopeId === 'string' ? r.renderScopeId : undefined,
    nx: asFinite(r.nx),
    ny: asFinite(r.ny),
  }
}

interface Connection {
  channel: RealtimeChannel
  workspaceId: string
  teardown: () => void
}

class PresenceClient {
  private conn: Connection | null = null
  private identity: PresenceIdentity = {
    clientId: sessionClientId,
    userId: '',
    name: '',
    color: '#888888',
  }
  private local: LocalPresence = EMPTY_LOCAL
  /** Peers keyed by their clientId. Always excludes self. */
  private remote = new Map<string, RemotePresence>()
  private cursors = new Map<string, RemoteCursor>()
  /** Stable array reused as the `useSyncExternalStore` snapshot until the
   *  cursor set actually changes — a fresh array every read would loop. */
  private cursorsSnapshot: readonly RemoteCursor[] = []

  private readonly presenceSubs = new CallbackSet('presence.presence')
  private readonly cursorSubs = new CallbackSet('presence.cursors')

  // ── lifecycle ──────────────────────────────────────────────────────────

  connect(opts: { workspaceId: string; user: { id: string; name?: string } }): void {
    if (!supabase || typeof window === 'undefined') return
    if (this.conn?.workspaceId === opts.workspaceId) return
    this.disconnect()

    // Narrowed once here so the teardown closure doesn't need a non-null
    // assertion on the module-level `supabase`.
    const client = supabase
    const { workspaceId, user } = opts
    this.identity = {
      clientId: sessionClientId,
      userId: user.id,
      name: user.name?.trim() || `User ${user.id.slice(0, 8)}`,
      color: colorForUser(user.id),
    }

    // Forward-compat: attach the user JWT so a future private (RLS-gated)
    // channel works without code change. Harmless on a public channel.
    const token = readPersistedSession()?.access_token
    if (token) {
      try { void client.realtime.setAuth(token) } catch { /* best-effort */ }
    }

    const channel = client.channel(`presence:${workspaceId}`, {
      config: { presence: { key: this.identity.clientId }, broadcast: { self: false } },
    })

    const resync = () => this.syncFromChannel(channel)
    channel.on('presence', { event: 'sync' }, resync)
    channel.on('presence', { event: 'join' }, resync)
    channel.on('presence', { event: 'leave' }, resync)
    channel.on('broadcast', { event: 'cursor' }, ({ payload }) =>
      this.onRemoteCursor(payload),
    )

    void channel.subscribe(status => {
      if (status === 'SUBSCRIBED') void channel.track({ ...this.trackPayload() })
    })

    const onPointerMove = (e: PointerEvent) => this.cursorThrottled(e)
    const onPointerGone = () => this.broadcastCursor(null)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerGone)
    window.addEventListener('blur', onPointerGone)

    this.conn = {
      channel,
      workspaceId,
      teardown: () => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerleave', onPointerGone)
        window.removeEventListener('blur', onPointerGone)
        this.cursorThrottled.cancel()
        this.trackThrottled.cancel()
        try { void channel.untrack() } catch { /* ignore */ }
        try { void client.removeChannel(channel) } catch { /* ignore */ }
      },
    }
  }

  disconnect(): void {
    if (!this.conn) return
    this.conn.teardown()
    this.conn = null
    this.local = EMPTY_LOCAL
    this.remote.clear()
    this.cursors.clear()
    this.cursorsSnapshot = []
    this.presenceSubs.notify()
    this.cursorSubs.notify()
  }

  // ── local publish ────────────────────────────────────────────────────────

  /** Merge a partial update into the local presence and (throttled) push it
   *  over the channel. No-ops when the merged state is unchanged so idle
   *  re-renders of the publisher don't spam `track`. */
  updateLocal(partial: Partial<LocalPresence>): void {
    const next: LocalPresence = { ...this.local, ...partial }
    if (JSON.stringify(next) === JSON.stringify(this.local)) return
    this.local = next
    this.trackThrottled()
  }

  private readonly trackThrottled = throttle(
    () => { if (this.conn) void this.conn.channel.track({ ...this.trackPayload() }) },
    TRACK_THROTTLE_MS,
    { leading: true, trailing: true },
  )

  private trackPayload(): RemotePresence {
    return { ...this.identity, ...this.local }
  }

  // ── cursor (broadcast) ─────────────────────────────────────────────────

  private readonly cursorThrottled = throttle(
    (e: PointerEvent) => this.handlePointerMove(e),
    CURSOR_THROTTLE_MS,
    { leading: true, trailing: true },
  )

  private handlePointerMove(e: PointerEvent): void {
    const target = e.target as Element | null
    // Scope to the block SHELL (`.tm-block`) — `data-block-id` alone also
    // appears on inline block-refs and property rows, which would anchor the
    // cursor to the wrong rectangle (and the resolver, picking the first
    // `data-block-id` match, could land on a different element entirely).
    const el = target?.closest?.('.tm-block[data-block-id]') as HTMLElement | null
    if (!el) { this.broadcastCursor(null); return }
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    this.broadcastCursor({
      ...this.identity,
      blockId: el.dataset.blockId ?? null,
      renderScopeId: el.dataset.renderScopeId,
      nx: (e.clientX - rect.left) / rect.width,
      ny: (e.clientY - rect.top) / rect.height,
    })
  }

  private broadcastCursor(cursor: RemoteCursor | null): void {
    if (!this.conn) return
    const payload: RemoteCursor = cursor ?? { ...this.identity, blockId: null, nx: 0, ny: 0 }
    void this.conn.channel.send({ type: 'broadcast', event: 'cursor', payload })
  }

  private onRemoteCursor(raw: unknown): void {
    const payload = normalizeCursor(raw)
    if (!payload || payload.clientId === this.identity.clientId) return
    if (payload.blockId == null) this.cursors.delete(payload.clientId)
    else this.cursors.set(payload.clientId, payload)
    this.rebuildCursors()
    this.cursorSubs.notify()
  }

  // ── remote ingest ──────────────────────────────────────────────────────

  private syncFromChannel(channel: RealtimeChannel): void {
    const state = channel.presenceState() as unknown as Record<string, RemotePresence[]>

    const next = new Map<string, RemotePresence>()
    for (const [key, entries] of Object.entries(state)) {
      if (key === this.identity.clientId) continue
      const normalized = normalizePresence(key, entries[0])
      if (normalized) next.set(key, normalized)
    }
    this.remote = next
    // A peer that left can never send a "cursor off" broadcast, so prune
    // their cursor here against the live presence set.
    let cursorsChanged = false
    for (const key of [...this.cursors.keys()]) {
      if (!next.has(key)) { this.cursors.delete(key); cursorsChanged = true }
    }
    if (cursorsChanged) this.rebuildCursors()
    this.presenceSubs.notify()
    if (cursorsChanged) this.cursorSubs.notify()
  }

  private rebuildCursors(): void {
    this.cursorsSnapshot = [...this.cursors.values()]
  }

  // ── selectors / subscriptions (consumed by hooks + CM extension) ─────────

  readonly subscribePresence = (cb: () => void): (() => void) => this.presenceSubs.add(cb)
  readonly subscribeCursors = (cb: () => void): (() => void) => this.cursorSubs.add(cb)
  readonly getCursors = (): readonly RemoteCursor[] => this.cursorsSnapshot

  /** Stable string of the colours of every peer "occupying" `blockId`
   *  (selected it, focused it, or editing it), e.g. `"hsl(..),hsl(..)"`.
   *  A primitive return means `useSyncExternalStore`'s `Object.is` only
   *  re-renders the blocks whose occupancy actually changed. */
  readonly selectionColorKey = (blockId: string): string => {
    const colors: string[] = []
    for (const peer of this.remote.values()) {
      if (this.occupies(peer, blockId)) colors.push(peer.color)
    }
    return colors.sort().join(',')
  }

  readonly caretsForBlock = (blockId: string): RemoteCaret[] => {
    const carets: RemoteCaret[] = []
    for (const peer of this.remote.values()) {
      const editor = peer.editor
      if (editor?.blockId === blockId && typeof editor.start === 'number') {
        carets.push({
          clientId: peer.clientId,
          name: peer.name,
          color: peer.color,
          start: editor.start,
          end: typeof editor.end === 'number' ? editor.end : editor.start,
        })
      }
    }
    return carets
  }

  private occupies(peer: RemotePresence, blockId: string): boolean {
    return (
      peer.selectedBlockIds.includes(blockId) ||
      peer.focusedBlockId === blockId ||
      peer.editor?.blockId === blockId
    )
  }
}

export const presenceClient = new PresenceClient()
