import { FunctionComponent } from 'react'
import { Block } from '@/data/block.ts'

export type BlockPropertyValue = string | number | Array<BlockPropertyValue> | boolean | undefined | object | null

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

// Outgoing reference. For page wikilinks ([[Some Page]]) `alias` is the
// human-typed text and `id` is the block resolved from it. For block refs
// (((uuid))) both `alias` and `id` are the target's UUID — the duplication
// keeps the row shape uniform so backlinks queries don't need to branch.
export interface BlockReference {
    id: string;
    alias: string;
}

// Each block is stored as a local PowerSync-backed SQLite record
export interface BlockData {
    id: string;
    workspaceId: string;
    content: string;
    properties: BlockProperties;
    childIds: string[];  // URLs of child block documents
    parentId?: string;   // URL of parent block document
    createTime: number;
    updateTime: number;
    createdByUserId: string;
    updatedByUserId: string;
    references: BlockReference[];  // Required, outgoing references to other blocks
    // Soft-delete flag. Block.delete() sets this true on the block and all its
    // descendants; the row stays in storage so undo can restore it. Workspace-
    // wide queries (e.g. findBlocksByType) MUST filter on this.
    deleted: boolean;
    // we are doing a lot of searching of my position within parent, plausibly the items should store it's position after all
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
