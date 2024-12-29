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

export type BlockRenderer = React.ComponentType<{
    block: Block;
    onUpdate: (block: Block) => void;
}>;

export interface RendererRegistry {
    [key: string]: BlockRenderer;
}
