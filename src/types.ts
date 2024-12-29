export interface BlockProperties {
    type?: string;
    [key: string]: string | undefined;
}

export interface Block {
    id: string;
    content: string;
    properties: BlockProperties;
    children: Block[];
}
