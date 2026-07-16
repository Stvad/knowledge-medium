import { FunctionComponent } from 'react'
import type { BlockData } from '@/data/api'
import { Block } from './data/block'

// BlockData / BlockReference are the canonical domain shape — their definition
// lives with the rest of the data-layer API in `@/data/api`. Re-exported here
// during the 1.6 migration; once consumers shift onto `@/data/api` directly
// this re-export drops.
export type { BlockData, BlockReference } from '@/data/api'

/** Loose alias for any decoded property value. The new shape stores
 *  encoded values (untyped JSON) in `BlockData.properties` and decodes
 *  via `block.get(schema)` / `block.peekProperty(schema)` at the
 *  boundary — `BlockPropertyValue` is just the union of plausible
 *  decoded shapes. */
export type BlockPropertyValue = string | number | boolean | object | undefined | null | Array<BlockPropertyValue>

/** Map of decoded property values keyed by name. Mirrors
 *  `BlockData['properties']` (which holds the encoded JSON) but typed
 *  as the decoded view for callers that work with the values
 *  pre-codec. */
export type BlockProperties = Record<string, unknown>

export type WorkspaceRole = 'owner' | 'editor' | 'viewer'

export interface Workspace {
  id: string
  name: string
  ownerUserId: string
  createTime: number
  updateTime: number
  // E2EE (docs/e2ee-design.html §7). `encryptionMode` is a server-
  // maintained UX hint / feature-gating projection; `wkCanary` is the
  // key-check blob a new device decrypts to validate a pasted WK (null for
  // plaintext workspaces). Carried through the domain so the optimistic
  // local prime after create_workspace doesn't null them out before sync.
  encryptionMode: string
  wkCanary: string | null
  // Properties-as-blocks rollout lever (PR #288 §6): 'cell' →
  // 'children' → 'cell-off', operator-written server-side (forward-only
  // trigger), synced to every client. "Flipped" is ALWAYS the
  // at-or-past-'children' test (`isChildBackedPropertiesWorkspace`),
  // never equality.
  propertiesMigration: PropertiesMigrationState
}

/** `workspaces.properties_migration` values, in rollout order. */
export type PropertiesMigrationState = 'cell' | 'children' | 'cell-off'

/** The one predicate every properties-as-blocks consumer shares
 *  (recognition, dual-write, projection, reconcile): child-backed =
 *  workspace flipped = at or past 'children'. Never an equality test —
 *  an equality gate would un-recognize every field row the moment a
 *  workspace advances to 'cell-off' (PR #288 §6). */
export const isChildBackedPropertiesWorkspace = (
  state: PropertiesMigrationState,
): boolean => state === 'children' || state === 'cell-off'

export interface WorkspaceMembership {
  id: string
  workspaceId: string
  userId: string
  role: WorkspaceRole
  createTime: number
}

export interface WorkspaceInvitation {
  id: string
  workspaceId: string
  workspaceName?: string  // populated by list_my_pending_invitations RPC
  email: string
  role: Exclude<WorkspaceRole, 'owner'>
  invitedByUserId: string
  createTime: number
}

export interface WorkspaceMemberWithEmail extends WorkspaceMembership {
  email: string
}

export interface BlockRendererProps {
    block: Block;
    context?: BlockContextType;
}

/**
 * Should this actually be an object with a `render` method?
 */
export interface BlockRenderer extends FunctionComponent<BlockRendererProps> {
    canRender?: (props: BlockRendererProps) => boolean;
    priority?: (props: BlockRendererProps) => number;
}

export interface RendererRegistry {
    [key: string]: BlockRenderer;
}

/** EditorSelectionState now lives at @/data/properties — re-exported
 *  here during the 1.6 migration so call sites that still import from
 *  @/types compile. Once consumers shift onto @/data/properties this
 *  re-export drops. */
export type { EditorSelectionState } from '@/data/properties'

export interface BlockContextType {
    /** Layout-dispatch boundary — gates which top-level renderer fires
     *  (`TopLevelRenderer` / `LayoutRenderer` / `PanelRenderer`). Reset
     *  by every layout boundary as it descends, so by the time
     *  `DefaultBlockRenderer` runs this is always `false`. Orthogonal
     *  to focal-block identity (`block.id === topLevelBlockId`) and to
     *  render surface (`isNestedSurface` and friends below). */
    layoutBoundary?: boolean
    safeMode?: boolean
    user?: {
        id: string
        name: string
    }
    panelId?: string
    layoutSessionBlockId?: string
    /** The pane's view mode (`panelViewModeProp` on the panel row), threaded
     *  by `PanelRenderer` around the top-level block render so renderer
     *  resolution (`canRender`) can select a mode-specific renderer. Children
     *  inherit it like any context field; a mode renderer that embeds normal
     *  block content clears it in its own `NestedBlockContextProvider`. */
    panelViewMode?: string
    /** Stable semantic identity for the rendered outline-like scope that
     *  contains this block. A logical block id plus this scope identifies
     *  one rendered occurrence of that block, even when the same block is
     *  visible in the main outline and one or more embeds/backlink rows. */
    renderScopeId?: string
    /** Id of the block rendered as the root of this surface's visible
     *  subtree: the panel's zoom root for the main outline, the shown
     *  block for a backlink entry, the embedded block for an embed, a
     *  single segment for a breadcrumb. Structural edits (create-below,
     *  indent/outdent, merge-up) and bounded navigation read this — NOT
     *  the panel's `topLevelBlockId` — so a block rendered as a root in
     *  a nested surface behaves like one. Every surface that mounts a
     *  block as a bounded view declares it; absent only at the very top
     *  layout boundary, before a panel sets it. See
     *  `resolveStructuralEditPolicy`. */
    scopeRootId?: string
    /** Single visible panel mode: widen the panel's scroll target to the
     *  whole layout surface while constraining its document content inside
     *  the panel renderer. */
    wideScrollSurface?: boolean
    /** Whether focus entering the panel body should mark this panel active.
     *  Desktop tracks focus for keyboard ownership; mobile renders only the
     *  active panel, so pointer activation is enough there. */
    trackPanelFocus?: boolean
    /** Umbrella surface flag — set by every non-document mount
     *  (`BlockEmbed`, `BacklinkEntry`, breadcrumb list). Consulted by
     *  `useIsFocalRender` / `isFocalRender` so a new surface only has
     *  to set the umbrella to be excluded from focal affordances. */
    isNestedSurface?: boolean
    /** Specific descriptors — set alongside `isNestedSurface` so
     *  consumers that need to discriminate the surface (e.g. a future
     *  embed-only header decoration) can ask the specific question.
     *  Composes in nested cases (a backlink containing an embed has
     *  both `isBacklink` and `isEmbedded` true). */
    isEmbedded?: boolean
    isBacklink?: boolean
    isBreadcrumb?: boolean
    /** A block rendered as an inline reference (`((id))`). Set alongside
     *  `isNestedSurface`, so it inherits focal-exclusion / nested-surface
     *  behaviour from the umbrella; the specific flag lets the reference
     *  layout self-gate (render the navigating link + raw content) without
     *  matching embeds or backlink entries. */
    isReference?: boolean
    [key: string]: unknown
}

export interface User {
  id: string
  name: string
}

export interface ClipboardData {
  markdown: string;
  blocks: BlockData[];
}
