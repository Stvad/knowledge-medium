/**
 * `ClientContext` — the client's indexical "acting-as" state: who is
 * acting (the authenticated user) and what they are acting on/at (the
 * active workspace pin, the active layout session).
 *
 * One instance per client, constructed and owned by its `Repo` (identity
 * is 1:1 with the Repo — `repo.client`). It is deliberately distinct
 * from the app's two other context notions:
 *
 *   - BLOCK context is positional — per-subtree, provided down the render
 *     tree, many per client;
 *   - the FACET runtime is contribution space — what code/capabilities
 *     are installed, not who is acting.
 *
 * Future acting-as state (device identity, impersonation, per-client
 * capability flags, …) belongs HERE, not on Repo: Repo composes this
 * object and keeps thin delegation shims for its existing public API,
 * but stops accreting indexical fields itself.
 *
 * This class holds bare state only — no Repo reference, no propagation.
 * Side-effectful transitions (facet-bridge notification, projector
 * re-pin, seed-materialization rescheduling on a workspace switch) live
 * in Repo's setters, which delegate just the field read/write here.
 *
 * `repo.client` and `useClientContext()` expose only the
 * {@link ClientContextReader} view (no set methods) — see its doc for
 * why. Repo holds the concrete `ClientContext` privately and is the only
 * caller of the set methods below (plus the reverse-direction shim test).
 *
 * Note on the `getLayoutSessionId` import: this file is on the ambient
 * accessor's allowlist (see the `@ambient` tag in
 * `src/utils/layoutSessionId.ts`) because the base-seed FALLBACK read
 * lives here — everything else must go through `activeLayoutSessionId`.
 */

import { getLayoutSessionId } from '@/utils/layoutSessionId'
import type { User } from '@/data/api/user.js'
import { CallbackSet } from '@/utils/callbackSet'

export interface ClientContextOptions {
  user: User
}

/** A same-workspace app route as the session router sees it: the clean
 *  workspace id plus the canonicalized ws-context entries (`key[=value]`,
 *  parse-sorted). Slots are deliberately absent — routing decides WHERE a
 *  route applies, never WHAT it applies. */
export interface LayoutSessionRoute {
  workspaceId: string
  wsContext: readonly string[]
}

/** The session consumer's route-owner: the single authority for "which
 *  layout session does a ws-context-bearing route address?". Core keeps
 *  ws-context opaque, so only the consumer that mints those entries can
 *  answer — it registers this via `repo.setLayoutSessionRouter` and URL
 *  application (`applyCurrentLayoutUrl`, and through it bootstrap and
 *  every projection) consults it instead of guessing.
 *
 *  Registration protocol: register EARLY (before switching sessions or
 *  installing context-bearing hashes), and keep
 *  `claimLayoutContextKey` in sync for your keys — persisted claims are
 *  what boots BEFORE your code loads use to defer your routes instead of
 *  applying them to the base session. Unregister (set null) on
 *  disable/uninstall together with releasing the claims. */
export interface LayoutSessionRouter {
  /** The session KEY (the `repo.client.activeLayoutSessionId` domain —
   *  NOT a block id; core derives the block id via
   *  layoutSessionBlockIdForKey) the route addresses, or `null` for the
   *  per-device base session (an empty string folds to base too — the
   *  natural `entry.slice('persp='.length)` idiom on a bare value must
   *  not mint an unreachable derived id). Only called for routes whose
   *  ws-context carries a claimed key; a throw is treated as "not
   *  addressed here" (defer) and logged. */
  resolveSessionKey(route: LayoutSessionRoute): string | null
}

/**
 * Read-only + subscribe view onto {@link ClientContext} — what `repo.client`
 * and `useClientContext()` expose. Deliberately omits `setActiveWorkspaceId`
 * / `setActiveLayoutSessionId`: those bypass Repo's transition (facet-bridge
 * notification, projector pin/rollback, seed-materialization generation
 * turnover), so a caller reaching them would silently desync those systems.
 * This type makes that mistake a compile error rather than a documented
 * convention. Mutate ONLY via `repo.setActiveWorkspaceId` /
 * `repo.setActiveLayoutSessionId`.
 */
export interface ClientContextReader {
  readonly user: User
  readonly activeWorkspaceId: string | null
  readonly activeLayoutSessionId: string
  /** The per-device BASE session id (the no-override fallback). Only for
   *  base-ness checks — see the class getter's doc. */
  readonly baseLayoutSessionId: string
  /** Read side of the layout-context claim registry, scoped to (this
   *  user, `workspaceId`) — see the class method's doc. (Claiming/releasing
   *  goes through the Repo shims, same split as the set methods above.) */
  hasClaimedLayoutContextKey(workspaceId: string, key: string): boolean
  /** The registered session route-owner, or null before the consumer
   *  loads (registration goes through `repo.setLayoutSessionRouter`).
   *  Its presence is also the "multi-session mode" signal: with a router
   *  up, a projection bound to a NON-base session defers base-addressed
   *  (context-free) routes instead of applying them. */
  readonly layoutSessionRouter: LayoutSessionRouter | null
  /** Subscribe to EFFECTIVE changes of either field (no-op sets — including
   *  the layout-session id's null⇄base-id folding — do not notify). Returns
   *  an idempotent unsubscribe. */
  onActingAsChange(listener: () => void): () => void
}

/** Device-local persistence for layout-context claims (see
 *  {@link ClientContext.claimLayoutContextKey}). Persisted as a map of
 *  `"<userId>/<workspaceId>" → keys` — consumers are installed per
 *  workspace and localStorage is shared across every account on the
 *  origin, so an unscoped claim made in workspace A would defer routes in
 *  workspace B where no consumer exists to pick them up. localStorage so
 *  a claim made by an async-loaded consumer is visible to the NEXT boot's
 *  synchronous bootstrap read; typeof-guarded so non-browser environments
 *  (node tests, SSR) degrade to in-memory claims. */
const LAYOUT_CONTEXT_CLAIMS_STORAGE_KEY = 'layout-context-claims'
/** Acquire localStorage WITHOUT trusting the getter: in an opaque-origin /
 *  sandboxed WebView (or under a deny-DOM-storage policy) merely evaluating
 *  `localStorage` throws SecurityError — and the claims read runs as a
 *  ClientContext field initializer, so an unguarded access would fail Repo
 *  construction instead of degrading to in-memory claims. */
const safeLocalStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
const layoutContextClaimScope = (userId: string, workspaceId: string): string =>
  `${userId}/${workspaceId}`
const readPersistedLayoutContextClaims = (): Map<string, Set<string>> => {
  const claims = new Map<string, Set<string>>()
  const storage = safeLocalStorage()
  if (!storage) return claims
  try {
    const raw = storage.getItem(LAYOUT_CONTEXT_CLAIMS_STORAGE_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [scope, keys] of Object.entries(parsed)) {
        if (!Array.isArray(keys)) continue
        claims.set(scope, new Set(keys.filter((key): key is string => typeof key === 'string')))
      }
    }
    return claims
  } catch {
    return claims
  }
}
const writePersistedLayoutContextClaims = (claims: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
  const storage = safeLocalStorage()
  if (!storage) return false
  try {
    const serialized = Object.fromEntries(
      [...claims.entries()]
        .filter(([, keys]) => keys.size > 0)
        .map(([scope, keys]) => [scope, [...keys].sort()]),
    )
    storage.setItem(LAYOUT_CONTEXT_CLAIMS_STORAGE_KEY, JSON.stringify(serialized))
    return true
  } catch {
    // Quota/private-mode failures degrade to in-memory claims (the caller
    // flips to in-memory-authoritative mode — see mutateLayoutContextClaims).
    return false
  }
}

export class ClientContext implements ClientContextReader {
  /** The authenticated user this client acts as. Written into
   *  `tx_context.user_id` / per-row `created_by` / `updated_by` by the
   *  commit pipeline (via `repo.tx`). */
  readonly user: User

  private _activeWorkspaceId: string | null = null
  /** `null` means "no override" — `activeLayoutSessionId` falls back to
   *  the per-device base id. */
  private _activeLayoutSessionId: string | null = null

  /** Ws-context keys session consumers have claimed on THIS device, keyed
   *  by `"<userId>/<workspaceId>"` scope — seeded from the persisted map so
   *  bootstrap (which runs before async user extensions load) sees claims
   *  made on earlier boots. A read cache, not the write source of truth —
   *  see mutateLayoutContextClaims. */
  private _claimedLayoutContextKeys = readPersistedLayoutContextClaims()

  /** Merge-on-write for the claim registry: re-read persisted state, apply
   *  the delta to the FRESH map, persist, and adopt the merged map as the
   *  new in-memory view (also absorbing other tabs' claims). The adoption
   *  happens even when the mutation is a NO-OP — an idempotent re-claim of
   *  a key another tab already persisted must still teach THIS tab's
   *  in-memory view about it, or hasClaimedLayoutContextKey lies right
   *  after the caller claimed. localStorage has no transactions, but this
   *  shrinks the lost-update window from "construction → write" to the
   *  microseconds between read and write — and claim/release are
   *  idempotent per (scope, key), so replays are harmless. */
  /** While a persist has FAILED (quota/private mode), storage is behind
   *  the in-memory map — a re-read would adopt the stale persisted state
   *  and silently drop the unpersisted claim, so reads are suspended and
   *  this instance is in-memory-authoritative. Writes are still attempted,
   *  and a SUCCESSFUL write clears the flag: at that instant storage
   *  equals the in-memory map, so merge-reads are safe again. (That
   *  healing write is a whole-map publish — claims peers persisted during
   *  the degraded window are overwritten by it, once; never resetting
   *  would instead make EVERY later write a clobber.) */
  private _claimsPersistenceDegraded = false

  private mutateLayoutContextClaims(mutate: (claims: Map<string, Set<string>>) => boolean): void {
    const hasStorage = safeLocalStorage() !== null
    const canReadPersisted = hasStorage && !this._claimsPersistenceDegraded
    const fresh = canReadPersisted ? readPersistedLayoutContextClaims() : this._claimedLayoutContextKeys
    const changed = mutate(fresh)
    this._claimedLayoutContextKeys = fresh
    // While DEGRADED, retry the healing write on EVERY mutation, no-ops
    // included — the common recovery path is an extension restart
    // idempotently re-claiming its keys, and gating on the delta would
    // leave storage stale until some effective mutation happens to come
    // along (the next boot would then read the stale claims).
    if (hasStorage && (changed || this._claimsPersistenceDegraded)) {
      this._claimsPersistenceDegraded = !writePersistedLayoutContextClaims(fresh)
    }
  }

  /** Fires on EFFECTIVE changes to `activeWorkspaceId` / `activeLayoutSessionId`
   *  — see {@link onActingAsChange}. Notified from THIS class's own set
   *  methods (single home for the state = single home for the notify); the
   *  Repo-side transition effects (facet-bridge, projectors, seed-generation)
   *  are separate and unrelated to this channel. */
  private readonly actingAsListeners = new CallbackSet<[]>('ClientContext.actingAsChange')

  constructor(opts: ClientContextOptions) {
    this.user = opts.user
  }

  onActingAsChange(listener: () => void): () => void {
    return this.actingAsListeners.add(listener)
  }

  /** UI-visible "active" workspace pin — used by plugin hooks and
   *  panels that need a default workspace when there's no other
   *  context. `repo.tx` does NOT consult this; tx workspaces come from
   *  the first write's row per spec §5.3. */
  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId
  }

  /** Bare state write — no propagation of the Repo-side switch effects.
   *  Everything outside Repo goes through `repo.setActiveWorkspaceId`,
   *  which owns those side effects (facet-bridge notification, projector
   *  pin/rollback, seed-materialization rescheduling) and delegates only
   *  the field write here. This method DOES fire {@link onActingAsChange}
   *  on an effective change — Repo's setter calls this first and performs
   *  its own side effects after, so a subscriber reacting synchronously
   *  could observe the pin already updated while the facet-bridge /
   *  projectors are still mid-transition (same hazard as any React
   *  re-render mid-transition today). */
  setActiveWorkspaceId(workspaceId: string | null): void {
    if (workspaceId === this._activeWorkspaceId) return
    this._activeWorkspaceId = workspaceId
    this.actingAsListeners.notify()
  }

  /** UI-visible "active" layout-session id — which panel-layout tree
   *  imperative code (actions, navigation helpers) should treat as "the
   *  session the user is looking at" (mirrors `activeWorkspaceId` above,
   *  replacing the module-global `getActiveLayoutSessionId` store it used
   *  to be). Falls back to the per-device BASE session id
   *  (`getLayoutSessionId()`, the boot seed) when no override has been
   *  set — so today, with nothing yet calling `setActiveLayoutSessionId`,
   *  this getter is behavior-identical to reading the base id directly. */
  get activeLayoutSessionId(): string {
    return this._activeLayoutSessionId ?? getLayoutSessionId()
  }

  /** Has some session consumer claimed this ws-context key for THIS user
   *  in `workspaceId` on this device? Read side of
   *  {@link claimLayoutContextKey} — URL application consults it to decide
   *  whether a context-bearing route is addressed to a consumer-selected
   *  session (defer at base) or is unclaimed noise (apply normally). */
  hasClaimedLayoutContextKey(workspaceId: string, key: string): boolean {
    return this._claimedLayoutContextKeys
      .get(layoutContextClaimScope(this.user.id, workspaceId))?.has(key) ?? false
  }

  /** Claim a ws-context key (e.g. `persp`) for a session consumer in
   *  `workspaceId`: routes for that workspace whose ws-context carries a
   *  claimed key are treated as addressed to a consumer-selected session,
   *  so the BASE session defers them (see applyCurrentLayoutUrl) instead
   *  of applying them to itself. Scoped to (user, workspace) — consumers
   *  are installed per workspace and localStorage is shared across the
   *  origin's accounts, so a broader claim would defer routes in
   *  workspaces that have no consumer. Idempotent; persisted per-device so
   *  bootstrap — which runs before async user extensions load — honors
   *  claims from earlier boots. Residue: the very first boot on a device
   *  where the consumer has never run yet applies a context URL to base;
   *  the consumer reconciles once it loads. Consumers should
   *  {@link releaseLayoutContextKey} when disabled/uninstalled, or a stale
   *  claim keeps deferring routes nothing will pick up — and on a boot
   *  where the base session also has no rows yet, a deferred route means
   *  a BLANK layout (deferral bypasses the empty-landing fallback by
   *  design: landing would rewrite the deferred route's hash). */
  claimLayoutContextKey(workspaceId: string, key: string): void {
    const scope = layoutContextClaimScope(this.user.id, workspaceId)
    this.mutateLayoutContextClaims(claims => {
      let keys = claims.get(scope)
      if (keys?.has(key)) return false
      if (!keys) {
        keys = new Set()
        claims.set(scope, keys)
      }
      keys.add(key)
      return true
    })
  }

  /** Undo {@link claimLayoutContextKey} for this user in `workspaceId`. */
  releaseLayoutContextKey(workspaceId: string, key: string): void {
    const scope = layoutContextClaimScope(this.user.id, workspaceId)
    this.mutateLayoutContextClaims(claims => claims.get(scope)?.delete(key) ?? false)
  }

  private _layoutSessionRouter: LayoutSessionRouter | null = null

  get layoutSessionRouter(): LayoutSessionRouter | null {
    return this._layoutSessionRouter
  }

  /** Register (or with `null` unregister) the session route-owner — see
   *  {@link LayoutSessionRouter} for the protocol. SINGLE-CONSUMER slot:
   *  there is one route-owner per client, and a second registration
   *  replaces the first (warned below — two session consumers cannot
   *  coexist; the claims registry supporting many keys does not change
   *  that). Deliberately no change notification: consumers register
   *  before driving any navigation, and URL application reads the router
   *  at apply time. */
  setLayoutSessionRouter(router: LayoutSessionRouter | null): void {
    if (router !== null && this._layoutSessionRouter !== null && this._layoutSessionRouter !== router) {
      console.warn('setLayoutSessionRouter: replacing an already-registered router — the layout-session route-owner is a single-consumer slot, and the previous consumer\'s routing just broke')
    }
    this._layoutSessionRouter = router
  }

  /** The per-device BASE layout-session id — what `activeLayoutSessionId`
   *  falls back to with no override. Exposed for the one question only the
   *  base id answers: "is this session block the base session?" — a
   *  ws-context-bearing route is never addressed to base, so URL
   *  application defers there (see applyCurrentLayoutUrl). Reading this is
   *  NOT a substitute for `activeLayoutSessionId` in imperative code. */
  get baseLayoutSessionId(): string {
    return getLayoutSessionId()
  }

  /** Override the active layout-session id; `null` restores the
   *  per-device base id. Unlike `setActiveWorkspaceId`, this deliberately
   *  has NO side-effectful Repo-side counterpart (no facetBridge / runtime
   *  notification, no reprime) — layout-session switching has no Repo-level
   *  transition to run, only the {@link onActingAsChange} notify below,
   *  fired on an EFFECTIVE change (comparing the resolved getter value, so
   *  a set that folds to the same base id — `null` ⇄ the current base id —
   *  is a no-op and does not notify). */
  setActiveLayoutSessionId(id: string | null): void {
    const previous = this.activeLayoutSessionId
    this._activeLayoutSessionId = id
    if (this.activeLayoutSessionId !== previous) this.actingAsListeners.notify()
  }
}
