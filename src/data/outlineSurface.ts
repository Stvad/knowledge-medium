import { displayScopeOf, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'

/**
 * The surface a gesture ran in, as the outline walkers need it: where the
 * visible subtree starts, whether that root is drawn open regardless of its
 * collapse flag, and which property rows the surface draws. The three travel
 * together because together they decide which rows are on screen.
 */
export interface OutlineSurface {
  /** Root of the visible subtree (the panel's zoom root, the shown block of a
   *  backlink entry, …). */
  readonly scopeRootId: string
  /** True for a focal panel/top-level root, drawn open whatever its collapse
   *  flag; false for a nested surface root, which honours the flag. */
  readonly scopeRootForcesOpen: boolean
  readonly propertyDisplay: PropertyDisplayScopeLevels
}

/** What a gesture's dependencies say about its surface (the fields
 *  `useShortcutSurfaceActivations` injects): any of it may be absent. */
export type SurfaceCarrier = Partial<OutlineSurface>

/** The surface `carrier` ran in, or null when it names no scope root (a
 *  global command, the bridge without a panel): there is then no visible
 *  subtree to walk. */
export const outlineSurfaceOf = (carrier: SurfaceCarrier): OutlineSurface | null =>
  carrier.scopeRootId
    ? {
      scopeRootId: carrier.scopeRootId,
      scopeRootForcesOpen: carrier.scopeRootForcesOpen ?? true,
      propertyDisplay: displayScopeOf(carrier),
    }
    : null
