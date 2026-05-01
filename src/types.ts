import { FunctionComponent } from 'react'
import type { BlockData } from '@/data/api'
import { Block } from '@/data/internals/block'

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
}

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
    topLevel?: boolean
    safeMode?: boolean
    user?: {
        id: string
        name: string
    }
    panelId?: string
    /** When true, DefaultBlockRenderer skips its recursive <BlockChildren>.
     *  Set by VirtualizedBlockTree, which renders descendants as siblings
     *  in a flat virtualized list. */
    suppressChildren?: boolean
    /** When true, BlockChildren mounts each child via <LazyBlockComponent>
     *  (intersection-observer placeholder) instead of <BlockComponent>.
     *  Set by PanelRenderer when render mode is 'lazy'. Inherits down the
     *  recursive render so descendants at every depth are also lazy. */
    lazyChildren?: boolean
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
