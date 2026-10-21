import { dedupById, defineFacet, keyedMapFacet } from '@/facets/facet.js'
import type { FacetRuntime } from '@/facets/facet.js'
import type { Repo } from '../data/repo'
import type { Block } from '../data/block'
import type { ProcessorRejection } from '@/data/api'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  type ActionTransform,
} from '@/shortcuts/types.js'
import type { ComponentType, ReactElement } from 'react'

export interface AppEffectContext {
  repo: Repo
  runtime: FacetRuntime
  workspaceId: string
  safeMode: boolean
}

/** Context passed to `workspaceLandingFacet` resolvers when the app
 *  boots into an empty layout (no panels in the URL hash). The
 *  resolver decides what block the user lands on — e.g. today's daily
 *  note. `freshlyCreated` is true on the very first run for a brand-
 *  new personal workspace; resolvers use it to seed first-run
 *  affordances (a [[Tutorial]] bullet etc.).
 *
 *  Runs BEFORE React mounts (inside App.tsx's bootstrap chain), so
 *  resolvers cannot use hooks or read the live `FacetRuntime`. Talk to the
 *  Repo directly, including for type/schema lookups via
 *  `repo.snapshotTypeRegistries()` — which at this point holds the
 *  `staticDataExtensions` registered onto the Repo at construction. A
 *  resolver that seeds blocks of a plugin type must ensure that plugin's
 *  data extension is in `staticDataExtensions`. */
export interface WorkspaceLandingContext {
  repo: Repo
  workspaceId: string
  freshlyCreated: boolean
  /** A block the caller must NOT be landed on, because it is being deleted.
   *  A resolver that would answer with this id must return null WITHOUT
   *  touching the DB — resolvers are get-or-create by contract (below), and
   *  `getOrCreateDailyNote` restores a soft-deleted row, so resolving the
   *  landing during delete-recovery would silently resurrect the page the
   *  user just deleted. Decide it from an id you can compute, not from a
   *  row you had to create first. Unset outside recovery (bootstrap).
   *
   *  Declining on an EXACT id match is not enough. The excluded id is the page
   *  of the pane being recovered, which need not be the root of the deleted
   *  subtree — a pane zoomed into a child recovers with the child's id, and a
   *  resolver that only checks equality sails past and recreates the deleted
   *  parent. If your resolver's get-or-create can restore an ancestor (or any
   *  other row) that the delete may have taken, check those for tombstones too
   *  — `anyBlockTombstoned` in `@/data/blockLiveness` reads them directly,
   *  which is necessary because the Block facade can't tell a tombstone from a
   *  row that simply isn't here. `todayDailyNoteLanding` does exactly this for
   *  today's note and the Journal. */
  excludeBlockId?: string
}

/** A landing resolver returns the block id to open, or null to defer
 *  to lower-precedence resolvers. The first resolver (in precedence
 *  order, highest first) that returns a non-null id wins.
 *
 *  The resolver is responsible for any side-effects needed to make
 *  that block exist (e.g. `getOrCreateDailyNote` calls a tx that
 *  inserts the row). Returning a block id whose row doesn't exist is
 *  a bug: the caller will navigate to it and break. */
export type WorkspaceLandingResolver = (
  ctx: WorkspaceLandingContext,
) => Promise<string | null>

export type AppEffectCleanup = () => void | Promise<void>

/**
 * A long-lived side-effect (subscription, interval, window listener, the
 * agent-runtime bridge) tied to the extension lifecycle. `start` runs once
 * when the effect first appears and returns an optional cleanup.
 *
 * Lifecycle contract — the reconciler restarts (cleanup + re-`start`) an
 * effect only when:
 *   1. `repo` / `workspaceId` / `safeMode` change (values `start` captures
 *      directly, not through the runtime), or
 *   2. the effect's *contribution object identity* changes — i.e. a
 *      different `AppEffect` reference is registered under the same `id`.
 *
 * Otherwise the effect keeps running across runtime swaps (extension
 * toggles, dynamic-plugin loads); the `runtime` it received is a live
 * handle that re-points itself at the fresh runtime, so `read` /
 * `onFacetChange` / `setRuntimeContributions` stay valid without a restart.
 *
 * This means the AppEffect object MUST be a stable reference across
 * resolves unless its code actually changed. Build it once at module scope
 * (or memoize it); do NOT construct `{id, start}` inline inside a
 * function-valued extension, and for dynamic extensions export an array,
 * not a function — a fresh object every resolve reads as "identity
 * changed" and silently restarts the effect on every unrelated swap.
 * Duplicate `id`s are last-wins with a warn (per the facet convention).
 * Cleanup must be idempotent and fast.
 */
export interface AppEffect {
  id: string
  start: (
    context: AppEffectContext,
  ) => void | AppEffectCleanup | Promise<void | AppEffectCleanup>
}

export interface AppMountContribution {
  id: string
  component: ComponentType
}

/** Per-panel mount point — components contributed via `panelMountsFacet`
 *  render once inside each `<PanelRenderer/>`'s root, with the panel's
 *  UI-state block passed as `block`. Use this for chrome that needs to
 *  live in panel scope (independent menu state per panel, panel-scoped
 *  DOM lookups, etc.) instead of the global `appMountsFacet` (one
 *  instance app-wide, no panel context).
 *
 *  Components are mounted as siblings to the panel's scrollable
 *  content, inside `.panel`, so they sit in the same positioning
 *  context as the panel's body. */
export interface PanelMountContribution {
  id: string
  component: ComponentType<{block: Block}>
}

export type HeaderItemRegion = 'start' | 'end'

export interface HeaderItemContribution {
  id: string
  region: HeaderItemRegion
  component: ComponentType
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isActionContextType = (value: unknown): value is ActionContextType =>
  typeof value === 'string' && value.length > 0

const isShortcutKeys = (value: unknown): value is string | string[] =>
  typeof value === 'string' || isStringArray(value)

const isShortcutBindingInput = (value: unknown): value is NonNullable<ActionConfig['defaultBinding']> =>
  isRecord(value) &&
  isShortcutKeys(value.keys) &&
  (value.eventOptions === undefined || isRecord(value.eventOptions))

export const isActionConfig = (value: unknown): value is ActionConfig =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.description === 'string' &&
  isActionContextType(value.context) &&
  typeof value.handler === 'function' &&
  (value.defaultBinding === undefined || isShortcutBindingInput(value.defaultBinding))

const isActionTransform = (value: unknown): value is ActionTransform =>
  isRecord(value) &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || isActionContextType(value.context)) &&
  typeof value.apply === 'function'

export const actionsFacet = defineFacet<ActionConfig, readonly ActionConfig[]>({
  id: 'core.actions',
  validate: isActionConfig,
})

/**
 * The one facet for contributing action transforms (replace / wrap /
 * unbind). The effective-actions pipeline runs every contribution in a
 * single ordered pass.
 */
export const actionTransformsFacet = defineFacet<ActionTransform, readonly ActionTransform[]>({
  id: 'core.action-transforms',
  validate: isActionTransform,
})

export const isAppEffect = (value: unknown): value is AppEffect =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.start === 'function'

export const appEffectsFacet = defineFacet<AppEffect, readonly AppEffect[]>({
  id: 'core.app-effects',
  validate: isAppEffect,
})

export const isAppMountContribution = (value: unknown): value is AppMountContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

// Dedup by logical `id` (last-wins) rather than the default keep-all: an
// app mount is rendered once per contribution keyed by `id` (see
// `AppMounts` in AppRuntimeProvider), and mounts are minted fresh inside
// plugin factories, so resolver identity dedup can't catch a logical
// duplicate — two same-id contributions would otherwise double-mount
// (#64). See `dedupById` for the tie-break rationale.
export const appMountsFacet = defineFacet<AppMountContribution, readonly AppMountContribution[]>({
  id: 'core.app-mounts',
  combine: dedupById('core.app-mounts'),
  validate: isAppMountContribution,
})

/** A plugin's toast for a `ProcessorRejection` code it emits. The plugin
 *  owns the body (copy, actions); core owns the imperative envelope
 *  (`showCustom`, duration) and the unknown-code fallback — see
 *  `extensions/processorRejectionToast`. Keyed by `code` (last-wins). */
export interface RejectionToastContribution {
  /** `ProcessorRejection.code` this renderer handles. */
  code: string
  /** Toast body for `error`. `toastId` lets the body dismiss itself;
   *  `repo` lets action buttons dispatch. Returning an element for
   *  malformed meta (rather than throwing) keeps a can't-happen case
   *  visible. */
  render: (error: ProcessorRejection, repo: Repo, toastId: string | number) => ReactElement
}

export const rejectionToastFacet = keyedMapFacet<RejectionToastContribution>(
  'core.rejection-toasts',
  c => c.code,
)

export const isPanelMountContribution = (value: unknown): value is PanelMountContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

// Per-panel render mount keyed by `id` — same double-mount hazard as
// `appMountsFacet`, so dedup by id (last-wins).
export const panelMountsFacet = defineFacet<PanelMountContribution, readonly PanelMountContribution[]>({
  id: 'core.panel-mounts',
  combine: dedupById('core.panel-mounts'),
  validate: isPanelMountContribution,
})

const isHeaderItemRegion = (value: unknown): value is HeaderItemRegion =>
  value === 'start' || value === 'end'

export const isHeaderItemContribution = (value: unknown): value is HeaderItemContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isHeaderItemRegion(value.region) &&
  typeof value.component === 'function'

// Header items are split into `start`/`end` regions and each region is
// rendered as its own list keyed by `id` (see Header.tsx), so the real
// render-key scope is `(region, id)` — dedup on that, NOT plain `id`.
// Plain-id dedup would wrongly collapse a `start` and an `end` item that
// share a logical id (dropping one) even though there's no key collision;
// region-scoped dedup still catches a genuine same-region double-render.
export const headerItemsFacet = defineFacet<HeaderItemContribution, readonly HeaderItemContribution[]>({
  id: 'core.header-items',
  combine: dedupById('core.header-items', item => `${item.region}:${item.id}`),
  validate: isHeaderItemContribution,
})

export const isActionContextConfig = (value: unknown): value is ActionContextConfig =>
  isRecord(value) &&
  isActionContextType(value.type) &&
  typeof value.displayName === 'string' &&
  (value.defaultEventOptions === undefined || isRecord(value.defaultEventOptions)) &&
  (value.eventFilter === undefined || typeof value.eventFilter === 'function') &&
  typeof value.validateDependencies === 'function'

export const actionContextsFacet = defineFacet<ActionContextConfig, readonly ActionContextConfig[]>({
  id: 'core.action-contexts',
  validate: isActionContextConfig,
})

/**
 * A veto on deleting a block THROUGH THE UI. Return a short user-facing reason
 * to refuse, or null to allow.
 *
 * This is a UI-layer affordance, deliberately not a data-layer guard: it exists
 * to stop a keystroke doing something pointless or destructive-looking, not to
 * make a row immortal. Programmatic callers (the agent bridge, migrations,
 * cleanup) go straight to `block.delete()` and are unaffected — the data layer's
 * own guards (`SeededDefinitionWriteError`, read-only workspaces) are the rules
 * that genuinely cannot be bypassed.
 *
 * The motivating case: pages that are get-or-CREATE by construction (today's
 * daily note, the Journal). Deleting one doesn't stick — revisiting the date
 * recreates it — so the gesture reads as broken while still destroying the
 * page's contents.
 */
export type BlockDeletionGuard = (block: Block) => Promise<string | null> | string | null

export const blockDeletionGuardsFacet = defineFacet<BlockDeletionGuard, readonly BlockDeletionGuard[]>({
  id: 'core.block-deletion-guards',
  validate: (value): value is BlockDeletionGuard => typeof value === 'function',
})

/** How long a single guard gets to answer before it is treated as "allow".
 *  Guards are supposed to be a types/id check; anything at this scale is a bug,
 *  and the alternative to giving up is a Delete key that hangs forever. */
const GUARD_TIMEOUT_MS = 5_000
/** Distinguishes "the timeout won the race" from a guard that legitimately
 *  answered null, so only the former is reported as broken. */
const GUARD_TIMED_OUT = Symbol('deletion-guard-timeout')

/** First refusal reason from any registered guard, or null when every guard
 *  allows the delete.
 *
 *  A guard that throws, rejects, hangs, or answers with something that isn't a
 *  non-empty string is logged and treated as "allow": guards come from
 *  user-installable extensions, and a broken one shouldn't be able to make
 *  blocks undeletable. (An earlier version handled only the throw/reject case,
 *  so a guard that never settled left `ensureDeletableThroughUi` awaiting
 *  forever — a permanent, silent veto, exactly what the rule forbids.) Erring
 *  toward allowing is the right side to fail on: the delete is soft and
 *  undoable, whereas an unresponsive gesture is not recoverable at all. */
export const resolveDeletionRefusal = async (
  repo: Repo,
  block: Block,
): Promise<string | null> => {
  for (const guard of repo.facetRuntime?.read(blockDeletionGuardsFacet) ?? []) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The timer is cleared in `finally`, so a guard that answers promptly
      // neither logs nor leaves a pending timeout behind.
      const reason = await Promise.race([
        Promise.resolve(guard(block)),
        new Promise<typeof GUARD_TIMED_OUT>(resolve => {
          timer = setTimeout(() => resolve(GUARD_TIMED_OUT), GUARD_TIMEOUT_MS)
        }),
      ])
      if (reason === GUARD_TIMED_OUT) {
        console.error('[deletion-guard] guard did not answer in time; allowing the delete')
        continue
      }
      if (!reason) continue
      if (typeof reason !== 'string') {
        console.error('[deletion-guard] guard returned a non-string reason; allowing the delete', reason)
        continue
      }
      return reason
    } catch (error) {
      console.error('[deletion-guard] guard threw; allowing the delete', error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return null
}

/** Plugins contribute landing resolvers; App.tsx tries them in order
 *  on bootstrap-with-empty-layout and uses the first non-null result.
 *  `FacetRuntime` sorts contributions ascending by `precedence`
 *  (default 0) before passing them here, so the highest-precedence
 *  resolver ends up LAST in the returned array; App.tsx walks the
 *  array in reverse so high-precedence wins. Without contributions the
 *  bootstrap leaves the layout empty — the panel projection then
 *  renders an empty panel stack, which is the historical fallback. */
export const workspaceLandingFacet = defineFacet<WorkspaceLandingResolver, readonly WorkspaceLandingResolver[]>({
  id: 'core.workspace-landing',
  validate: (value): value is WorkspaceLandingResolver => typeof value === 'function',
})
