import { FunctionComponent } from 'react'
import { Block } from '@/data/block.ts'

export type BlockPropertyValue = string | number | Array<BlockPropertyValue> | boolean | undefined

export interface BlockProperties {
    type?: string;
    renderer?: string;  // Reference to another block's document URL for renderer
    [key: string]: BlockPropertyValue;
}

// Each block is its own Automerge document
export interface BlockData {
    id: string;
    content: string;
    properties: BlockProperties;
    childIds: string[];  // URLs of child block documents
    parentId?: string;   // URL of parent block document
    // we are doing a lot of searching of my position within parent, plausibly the items should store it's position after all
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

// Temporary interface during migration - will be removed later
export interface RootDoc {
    rootBlockIds: string[];  // URLs of root-level blocks
}

export interface BlockContextType {
    topLevel?: boolean
    topLevelBlockId?: string
    safeMode?: boolean
    focusedBlockId?: string
    setFocusedBlockId?: (id: string | undefined) => void
    selection?: {
        blockId: string
        start: number
        end: number
    }
    setSelection?: (selection: { blockId: string; start: number; end: number } | undefined) => void
}
