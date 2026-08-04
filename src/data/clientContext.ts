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
  /** Read side of the layout-context claim registry — see the class
   *  method's doc. (Claiming/releasing goes through the Repo shims, same
   *  split as the set methods above.) */
  hasClaimedLayoutContextKey(key: string): boolean
  /** Subscribe to EFFECTIVE changes of either field (no-op sets — including
   *  the layout-session id's null⇄base-id folding — do not notify). Returns
   *  an idempotent unsubscribe. */
  onActingAsChange(listener: () => void): () => void
}

/** Device-local persistence for layout-context claims (see
 *  {@link ClientContext.claimLayoutContextKey}). localStorage so a claim
 *  made by an async-loaded consumer is visible to the NEXT boot's
 *  synchronous bootstrap read; typeof-guarded so non-browser environments
 *  (node tests, SSR) degrade to in-memory claims. */
const LAYOUT_CONTEXT_CLAIMS_STORAGE_KEY = 'layout-context-claims'
const readPersistedLayoutContextClaims = (): string[] => {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(LAYOUT_CONTEXT_CLAIMS_STORAGE_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}
const writePersistedLayoutContextClaims = (keys: ReadonlySet<string>): void => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LAYOUT_CONTEXT_CLAIMS_STORAGE_KEY, JSON.stringify([...keys].sort()))
  } catch {
    // Quota/private-mode failures degrade to in-memory claims.
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

  /** Ws-context keys some session consumer has claimed on THIS device —
   *  seeded from the persisted set so bootstrap (which runs before async
   *  user extensions load) sees claims made on earlier boots. */
  private readonly _claimedLayoutContextKeys = new Set<string>(readPersistedLayoutContextClaims())

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

  /** Has some session consumer claimed this ws-context key on this device?
   *  Read side of {@link claimLayoutContextKey} — URL application consults
   *  it to decide whether a context-bearing route is addressed to a
   *  consumer-selected session (defer at base) or is unclaimed noise
   *  (apply normally). */
  hasClaimedLayoutContextKey(key: string): boolean {
    return this._claimedLayoutContextKeys.has(key)
  }

  /** Claim a ws-context key (e.g. `persp`) for a session consumer: routes
   *  whose ws-context carries a claimed key are treated as addressed to a
   *  consumer-selected session, so the BASE session defers them (see
   *  applyCurrentLayoutUrl) instead of applying them to itself. Idempotent;
   *  persisted per-device so bootstrap — which runs before async user
   *  extensions load — honors claims from earlier boots. Residue: the very
   *  first boot on a device where the consumer has never run yet applies a
   *  context URL to base; the consumer reconciles once it loads. Consumers
   *  should {@link releaseLayoutContextKey} when disabled/uninstalled, or a
   *  stale claim keeps deferring routes nothing will pick up. */
  claimLayoutContextKey(key: string): void {
    if (this._claimedLayoutContextKeys.has(key)) return
    this._claimedLayoutContextKeys.add(key)
    writePersistedLayoutContextClaims(this._claimedLayoutContextKeys)
  }

  /** Undo {@link claimLayoutContextKey}. */
  releaseLayoutContextKey(key: string): void {
    if (!this._claimedLayoutContextKeys.delete(key)) return
    writePersistedLayoutContextClaims(this._claimedLayoutContextKeys)
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
