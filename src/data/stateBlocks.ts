/**
 * User-local state plumbing — per-user "user page", synced user prefs,
 * per-plugin sub-blocks, and per-panel ui-state child tree. Pure
 * (non-React) helpers live here; React hooks that consume them live in
 * `globalState.ts`. Splitting along this fault line keeps module-init
 * import graphs out of `react`/`@/context/repo`, which is what lets
 * `pluginStateExtensions.ts` import these helpers statically without
 * cycling through `repoProvider → staticDataExtensions → plugin/*`.
 *
 * Deterministic ids derived from (workspace, user, ...) keep two
 * offline clients converging on the same row when they later sync.
 */

import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
import {
  ChangeScope,
  type PropertySchema,
  type TypeContribution,
  type User,
} from '@/data/api'
import { Block } from './block'
import type { Repo } from './repo'
import type { BlockContextType } from '@/types'
import {
  addBlockTypeToProperties,
  aliasesProp,
  selectionStateProp,
  type BlockSelectionState,
} from '@/data/properties'
import { USER_PREFS_PATH_PART } from '@/data/userPrefs.ts'

// ──── Deterministic-id namespaces ────

// Per-user "user page" — parent-less alias-bearing block hosting the
// user's prefs + UI-state subtree for a given workspace. This namespace
// intentionally differs from the pre-UserPrefs UI-state namespace, whose
// rows were local-ephemeral and may not exist on the server.
const USER_PAGE_NS = '99b1b4e5-6f58-4fd2-9089-dc3b358dd4df'
// Per-(parent, content) state child — used by the bootstrap below
// (user-prefs, ui-state, panels, panel/main, etc.) so each name resolves
// to the same block id across clients.
const STATE_CHILD_NS = '8f6c2c84-1c12-4e4a-8b9e-9b0f87a7e1d2'

const userPageBlockId = (workspaceId: string, userId: string): string =>
  uuidv5(`${workspaceId}:${userId}`, USER_PAGE_NS)

const stateChildBlockId = (parentId: string, content: string): string =>
  uuidv5(`${parentId}:${content}`, STATE_CHILD_NS)

// ──── Helpers ────

export const requireWorkspaceId = (repo: Repo, caller: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    throw new Error(`${caller} requires an active workspace; call repo.setActiveWorkspaceId() first`)
  }
  return workspaceId
}

export const requireSchemaScope = <T>(
  schema: PropertySchema<T>,
  scope: ChangeScope,
  caller: string,
): PropertySchema<T> => {
  if (schema.changeScope !== scope) {
    throw new Error(`${caller} expected ${scope} property ${schema.name}, got ${schema.changeScope}`)
  }
  return schema
}

/** Idempotent state child creation. Returns the Block facade for
 *  the child whose content equals `content` under `parent`. The id
 *  comes from `stateChildBlockId(parentId, content)` so repeat calls hit
 *  the same row deterministically. Restores soft-deleted rows in the
 *  same scope.
 *
 *  Cold-start fast path: if the child is already live in cache or in
 *  SQL (the common case after the first launch), skip the
 *  writeTransaction entirely. The bootstrap path through this helper
 *  is called from at least four memoized parents (user-prefs,
 *  ui-state, panels, plus per-plugin children); a no-op tx still
 *  costs ~100 ms each because of trigger overhead, so amortizing
 *  those across cold start has been a measurable cost. The slow
 *  path is identical to before — `tx.get` re-checks under the lock
 *  to handle the (rare) tombstone case that `repo.load` filters out
 *  with its `deleted = 0` predicate. */
const ensureStateChild = async (
  repo: Repo,
  parent: Block,
  /** Stable internal key for the deterministic child id. Two clients
   *  bootstrapping the same logical state row must pass the same string
   *  here so the rows converge on sync. */
  namespace: string,
  scope: ChangeScope,
  initialProperties: Record<string, unknown> = {},
  /** Human-readable row content (the block's page title / navigation
   *  label). Defaults to `namespace` for state children whose title is
   *  intentionally internal (`ui-state`, `layout-sessions`, …). */
  displayContent: string = namespace,
): Promise<Block> => {
  const parentData = parent.peek() ?? await parent.load()
  if (!parentData) throw new Error(`ensureStateChild: parent ${parent.id} not loaded`)
  const childId = stateChildBlockId(parent.id, namespace)

  const live = await repo.load(childId)
  if (live && !live.deleted) {
    return repo.block(childId)
  }

  await repo.tx(async tx => {
    const existing = await tx.get(childId)
    if (existing && !existing.deleted) {
      return
    }
    if (existing && existing.deleted) {
      await tx.restore(childId, {content: displayContent})
      return
    }
    // Fresh insert. Use 'a0' as a starter order key — fine because
    // state children don't compete for ordering with user-authored
    // siblings beyond the bootstrap bucket; if we ever add multiple
    // ordered state children, swap to keyAtEnd.
    await tx.create({
      id: childId,
      workspaceId: parentData.workspaceId,
      parentId: parent.id,
      orderKey: 'a0',
      content: displayContent,
      properties: initialProperties,
    })
  }, {scope, description: `ensureStateChild ${namespace}`})

  const child = repo.block(childId)
  await child.load()
  return child
}

const ensureUiChild = (repo: Repo, parent: Block, namespace: string): Promise<Block> =>
  ensureStateChild(repo, parent, namespace, ChangeScope.UiState)

const ensureUserPrefsChild = (repo: Repo, parent: Block): Promise<Block> =>
  ensureStateChild(
    repo,
    parent,
    USER_PREFS_PATH_PART,
    ChangeScope.UserPrefs,
    {},
    'Preferences',
  )

// ──── Bootstrap blocks ────

/** Per-user "user page" block — created (or restored) on first access.
 *  The alias matches the user's display name so alias-based lookup
 *  surfaces can target it directly. Memoized per (repo, workspaceId,
 *  userId) — `use()` requires a stable promise per render.
 *
 *  The fast path uses `repo.load` to skip the tx entirely when the row
 *  is already live in cache or in SQL. Tombstone branch lives INSIDE
 *  the tx because `repo.load` filters `deleted = 0` (so tombstones
 *  always come back as `null`); we have to use `tx.get` to see them. */
export const getUserBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User): Promise<Block> => {
    const id = userPageBlockId(workspaceId, user.id)
    const live = await repo.load(id)
    if (live && !live.deleted) return repo.block(id)

    // User.name is optional in the data-layer User shape; fall back
    // to the id so the user-page block always has *some* content
    // and an addressable alias.
    const displayName = user.name ?? user.id

    await repo.tx(async tx => {
      // Re-read inside the tx with the unfiltered `tx.get` so we see
      // tombstones. (`repo.load` returned null in that case, so the
      // outer `live` is no signal here.) Three outcomes:
      //   1. live row appeared between load and tx open  → no-op
      //   2. tombstoned row                              → restore
      //   3. truly missing                               → create
      const existing = await tx.get(id)
      if (existing && !existing.deleted) return
      if (existing && existing.deleted) {
        await tx.restore(id, {content: displayName})
        await tx.setProperty(id, aliasesProp, [displayName])
        return
      }
      await tx.create({
        id,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: displayName,
        properties: {[aliasesProp.name]: aliasesProp.codec.encode([displayName])},
      })
    }, {scope: ChangeScope.UserPrefs})

    return repo.block(id)
  },
  (repo, workspaceId, user) => `${repoIdentity(repo)}:${workspaceId}:${user.id}`,
)

export const getUserPrefsBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User): Promise<Block> => {
    const userBlock = await getUserBlock(repo, workspaceId, user)
    return ensureUserPrefsChild(repo, userBlock)
  },
  (repo, workspaceId, user) => `${repoIdentity(repo)}:${workspaceId}:${user.id}:__user_prefs__`,
)

/** Per-plugin preferences sub-block under the root user-prefs block.
 *  Each plugin gets its own child keyed by the type contribution's `id`,
 *  carrying that id as its block type marker. Splitting preferences across
 *  per-plugin rows (rather than packing them all into the root block's
 *  `properties_json`) bounds the blast radius of any single PATCH upload
 *  to one plugin's settings — the row-level UPDATE trigger writes the full
 *  `properties_json` column on any property change, so unrelated plugins'
 *  values are no longer at risk of being clobbered by a peer's edit. */
export const getPluginPrefsBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    type: TypeContribution,
  ): Promise<Block> => {
    const userPrefsBlock = await getUserPrefsBlock(repo, workspaceId, user)
    return ensureStateChild(
      repo,
      userPrefsBlock,
      type.id,
      ChangeScope.UserPrefs,
      addBlockTypeToProperties({}, type.id),
      type.label ?? type.id,
    )
  },
  (repo, workspaceId, user, type) =>
    `${repoIdentity(repo)}:${workspaceId}:${user.id}:plugin-prefs:${type.id}`,
)

/** Resolve the UI-state block scoped to the current panel context.
 *  In a panel context (`context.panelId`), returns the panel's own
 *  block — per-panel UI state lives directly on it. Outside a panel,
 *  returns the user-level `ui-state` child of the user page. */
export const getUIStateBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    context: BlockContextType,
  ): Promise<Block> => {
    if (context.panelId) {
      await repo.load(context.panelId)
      return repo.block(context.panelId)
    }

    const userBlock = await getUserBlock(repo, workspaceId, user)
    return ensureUiChild(repo, userBlock, 'ui-state')
  },
  (repo, workspaceId, user, context) =>
    `${repoIdentity(repo)}:${workspaceId}:${user.id}:${context.panelId ?? '__root__'}`,
)

const LAYOUT_SESSIONS_PATH_PART = 'layout-sessions'
export const getLayoutSessionBlock = memoize(
  async (uiStateBlock: Block, layoutSessionId: string): Promise<Block> => {
    const layoutSessionsBlock = await ensureUiChild(uiStateBlock.repo, uiStateBlock, LAYOUT_SESSIONS_PATH_PART)
    return ensureUiChild(uiStateBlock.repo, layoutSessionsBlock, layoutSessionId)
  },
  (uiBlock, layoutSessionId) => `${repoIdentity(uiBlock.repo)}:${uiBlock.id}:${layoutSessionId}`,
)

/** Per-plugin ui-state sub-block under the root ui-state block. The
 *  mirror of `getPluginPrefsBlock` for state that is persistent but
 *  per-device (and therefore should NOT sync) — e.g. "what blocks did
 *  the user open recently on this device". Writes flow through
 *  `ChangeScope.UiState` so they stay out of the upload queue. */
export const getPluginUIStateBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    type: TypeContribution,
  ): Promise<Block> => {
    const rootUIStateBlock = await getUIStateBlock(repo, workspaceId, user, {})
    return ensureStateChild(
      repo,
      rootUIStateBlock,
      type.id,
      ChangeScope.UiState,
      addBlockTypeToProperties({}, type.id),
      type.label ?? type.id,
    )
  },
  (repo, workspaceId, user, type) =>
    `${repoIdentity(repo)}:${workspaceId}:${user.id}:plugin-ui-state:${type.id}`,
)

// ──── Selection-state helpers (pure operations on a Block) ────

/** Sync selection-state read; doesn't subscribe — for use in
 *  imperative shortcut handlers. Returns the schema default when
 *  nothing's stored. */
export const getSelectionStateSnapshot = (uiStateBlock: Block): BlockSelectionState =>
  uiStateBlock.peekProperty(selectionStateProp) ?? selectionStateProp.defaultValue

export const resetBlockSelection = async (uiStateBlock: Block): Promise<void> => {
  const current = uiStateBlock.peekProperty(selectionStateProp)
  if (!current?.selectedBlockIds.length && !current?.anchorBlockId) return
  await uiStateBlock.set(selectionStateProp, {selectedBlockIds: [], anchorBlockId: null})
}

// ──── Internal: shorthand for instance-scoped memo keys ────
const repoIdentity = (repo: Repo): number => repo.instanceId
