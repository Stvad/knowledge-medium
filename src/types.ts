import { FunctionComponent } from 'react'
import { Block } from '@/data/block.ts'

// BlockData / BlockReference are the canonical domain shape; their definition
// lives with the rest of the data-layer API in `@/data/api`. Re-exported here
// for backwards-compatibility with call sites that still import from `@/types`
// — the call-site sweep in stage 1.6 of the data-layer redesign will move
// imports onto `@/data/api` directly and this re-export will drop.
export type { BlockData, BlockReference } from '@/data/api'

export type BlockPropertyValue = string | number | Array<BlockPropertyValue> | boolean | undefined | object | null

// Legacy descriptor-shaped property API. Survives stages 1.2–1.5 alongside the
// new flat `properties: Record<string, unknown>` storage shape; gets fully
// retired in stage 1.6 when callers migrate to PropertySchema<T> + tx.setProperty.
export interface BlockProperty {
    name: string
    type: string
    value: BlockPropertyValue
    changeScope?: string
}

export interface StringBlockProperty extends BlockProperty {
    type: 'string'
    value: string | undefined
}

export interface NumberBlockProperty extends BlockProperty {
    type: 'number'
    value: number | undefined
}

export interface BooleanBlockProperty extends BlockProperty {
    type: 'boolean'
    value: boolean | undefined
}

export interface ListBlockProperty<V extends BlockPropertyValue> extends BlockProperty {
    type: 'list'
    value: Array<V> | undefined
}

export interface ObjectBlockProperty<V extends object> extends BlockProperty {
    type: 'object'
    value: V | undefined
}

export interface BlockProperties {
    type?: StringBlockProperty;
    // renderer?: string;  // Reference to another block's document URL for renderer
    previousLoadTime?: NumberBlockProperty
    // currentLoadTime?: number
    // 'system:collapsed'?: boolean,
    // 'system:showProperties'?: boolean,

    [key: string]: BlockProperty | undefined;
}

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

export interface EditorSelectionState {
    blockId: string
    start?: number
    end?: number
    line?: 'first' | 'last'
    x?: number
    y?: number
}

export interface BlockContextType {
    topLevel?: boolean
    safeMode?: boolean
    user?: {
        id: string
        name: string
    }
    panelId?: string
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
