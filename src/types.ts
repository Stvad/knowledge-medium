import type {ComponentType} from 'react'

export interface BlockProperties {
    type?: string;
    renderer?: string;  // Reference to another block's ID that defines a renderer
    [key: string]: string | undefined;
}

export interface Block {
    id: string;
    content: string;
    properties: BlockProperties;
    children: Block[];
}

export interface BlockRendererProps {
    block: Block;
    onUpdate: (block: Block) => void;
}

export type BlockRenderer = ComponentType<BlockRendererProps>;

export interface RendererRegistry {
    [key: string]: BlockRenderer;
}
