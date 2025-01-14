import type {ComponentType} from 'react'
import {Block} from '@/data/block.ts'

export interface BlockProperties {
    type?: string;
    renderer?: string;  // Reference to another block's document URL for renderer
    [key: string]: string | undefined;
}

// Each block is its own Automerge document
export interface BlockData {
    id: string;
    content: string;
    properties: BlockProperties;
    childIds: string[];  // URLs of child block documents
    parentId?: string;   // URL of parent block document
}

export interface BlockRendererProps {
    block: Block;
}

export type BlockRenderer = ComponentType<BlockRendererProps>;

export interface RendererRegistry {
    [key: string]: BlockRenderer;
}

// Temporary interface during migration - will be removed later
export interface RootDoc {
    rootBlockIds: string[];  // URLs of root-level blocks
}
