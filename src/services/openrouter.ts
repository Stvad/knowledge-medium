import { Block, getRootBlock } from '@/data/block'
import { getUserBlock } from '@/data/globalState'
import { User } from '@/types'
import { refreshRendererRegistry } from '@/hooks/useRendererRegistry.tsx'
import { clientLocalSettings } from '@/utils/ClientLocalSettings'

interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

type OpenRouterResult = {
  id: string;
  choices: {
    message: {
      content: string;
      role: string;
    };
    index: number;
    finish_reason: string;
  }[];
}

type OpenRouterError = {
  error: {
    message: string;
    code: string;
    metadata: unknown;
  },
  user_id: string
}

type OpenRouterResponse = OpenRouterResult | OpenRouterError

const LOCALSTORAGE_API_KEY = 'omniliner-openrouter-apikey'

const getOpenRouterConfigBlock = async (rootBlock: Block, user: User) => {
  const userBlock = await getUserBlock(rootBlock, user)
  return await userBlock.childByContent('openrouter', true)
}

/**
 * Gets OpenRouter configuration from UI state, with API key from localStorage
 */
export const getOpenRouterConfig = async (rootBlock: Block, user: User): Promise<OpenRouterConfig> => {
  const configBlock = await getOpenRouterConfigBlock(rootBlock, user)
  const blockData = await configBlock.data()

  return {
    baseUrl: blockData?.properties['baseUrl'] as string || 'https://openrouter.ai/api/v1',
    model: blockData?.properties['model'] as string || 'anthropic/claude-3.7-sonnet:beta',
    apiKey: clientLocalSettings.getString(LOCALSTORAGE_API_KEY, ''),
  }
}

/**
 * Save API key to localStorage
 */
export const saveOpenRouterApiKey = (apiKey: string) => {
  clientLocalSettings.setString(LOCALSTORAGE_API_KEY, apiKey)
}

/**
 * Save OpenRouter configuration to UI state
 */
export const saveOpenRouterConfig = async (
  rootBlock: Block,
  user: User,
  config: OpenRouterConfig,
) => {
  saveOpenRouterApiKey(config.apiKey)
  const configBlock = await getOpenRouterConfigBlock(rootBlock, user)

  // Update property directly using change method
  configBlock.change(doc => {
    doc.properties['baseUrl'] = config.baseUrl
    doc.properties['model'] = config.model
  }, {scope: 'plugin-settings'})
}

/**
 * Generate a renderer given block data and create a renderer block to store it
 */
export const generateRendererBlock = async (
  block: Block,
  options: {
    includeChildren?: boolean,
    rendererName?: string,
    customPrompt?: string
  } = {},
): Promise<Block> => {
  // Generate the renderer code
  const rendererCode = await generateRenderer(block, options)

  // Get the root block
  const rootBlock = await getRootBlock(block)

  // Find or create the renderers container block
  const renderersBlock = await rootBlock.childByContent(['system', 'renderers'], true)

  // Create a new renderer block
  const rendererBlock = await renderersBlock.createChild({
    data: {
      content: rendererCode,
      properties: {
        type: 'renderer',
        rendererName: options.rendererName || `custom-${Date.now()}`,
        sourceBlockId: block.id,
        createdAt: Date.now(),
      },
    },
  })

  refreshRendererRegistry()
  return rendererBlock
}

/**
 * Generate renderer code using Claude via OpenRouter
 */
export const generateRenderer = async (
  block: Block,
  options: {
    includeChildren?: boolean,
    rendererName?: string,
    customPrompt?: string
  } = {},
): Promise<string> => {
  const blockData = await block.data()
  if (!blockData) throw new Error('Block data is missing')

  // Get config from the user's UI state
  const rootBlock = await getRootBlock(block)
  const config = await getOpenRouterConfig(
    rootBlock,
    block.currentUser,
  )

  if (!config.apiKey) {
    throw new Error('OpenRouter API key not configured')
  }

  // Gather content from this block and children if needed
  let childrenContent = ''

  if (options.includeChildren) {
    const children = await block.children()
    childrenContent = (await Promise.all(children.map(async (child) => {
      const childData = await child.data()
      return childData ? `--- Child Block (${child.id}) ---\n${childData.content}\n` : ''
    }))).join('\n')
  }

  // Create the prompt for Claude
  const systemPrompt = `You are a specialized AI assistant that creates React component renderers for a knowledge management application.
Your task is to create a custom renderer that will display the content of blocks in an visually appealing and interactive way.

The renderer should:
1. Be a functional React component that accepts a 'block' prop of type Block
2. Use TypeScript and follow modern React best practices
3. Access block data via block.use() which returns BlockData
4. Organize and display the content in a way that makes sense for the provided data
5. Include basic styling using Tailwind CSS classes
6. Be error-resistant and handle missing or malformed data gracefully

The renderer can use dependencies importable with http imports. e.g. npm packages from esm.sh
You MUST use esm.sh to import any third party dependencies.

Here is documentation for Block class:
export declare class Block {
    readonly repo: Repo;
    readonly undoRedoManager: UndoRedoManager;
    private readonly handle;
    readonly currentUser: User;
    id: AutomergeUrl;
    constructor(repo: Repo, undoRedoManager: UndoRedoManager, handle: DocHandle<BlockData>, currentUser: User);
    data(): Promise<import("@automerge/automerge").Doc<BlockData> | undefined>;
    dataSync(): import("@automerge/automerge").Doc<BlockData> | undefined;
    parent(): Promise<Block | null>;
    parents(): Promise<Block[]>;
    children(): Promise<Block[]>;
    change(callback: ChangeFn<BlockData>, options?: ChangeOptions<BlockData>): void;
    _transaction(callback: () => void, options?: ChangeOptions<BlockData>): void;
    _change(callback: ChangeFn<BlockData>, options?: ChangeOptions<BlockData>): void;
    index(): Promise<number>;
    /**
     * todo we should outdent outside the view point, but that's not something this function can be aware of
     */
    outdent(): Promise<void>;
    indent(): Promise<void>;
    changeOrder(shift: number): Promise<void>;
    /**
     * Doesn't actually delete the doc for now, just removes it from the parent
     */
    delete(): Promise<void>;
    insertChildren({ blocks, position }: {
        blocks: Block[];
        position?: 'first' | 'last' | number;
    }): Promise<void>;
    private createSibling;
    createSiblingBelow(data?: Partial<BlockData>): Promise<Block | undefined>;
    createSiblingAbove(data?: Partial<BlockData>): Promise<Block | undefined>;
    /**
     * Find a block by following a content path, optionally creating blocks if they don't exist
     * @param contentPath Either a single string to match against direct children, or an array of strings defining a path through the hierarchy
     * @param createIfNotExists If true and no matching block is found, creates new blocks with the given content
     * @returns The found or created block, or null if not found and creation not requested
     * Todo: rebuild with future data access layer for perf
     */
    childByContent(contentPath: string | string[], createIfNotExists: true): Promise<Block>;
    childByContentPath(path: string[], createIfNotExists: boolean): Promise<Block | null>;
    /**
     * React hook for accessing the block's data. For use only in React components.
     */
    use(): import("@automerge/automerge").Doc<BlockData> | undefined;
    useProperty<T extends BlockPropertyValue>(name: string): [T | undefined, (value: T) => void];
    useProperty<T extends BlockPropertyValue>(name: string, initialValue: T, scope?: string): [T, (value: T) => void];
    _updateParentId: (newParentId: string) => void;
    updateParentId: (newParentId: string) => void;
    private getDocOrThrow;
    createChild({ data, position }?: {
        data?: Partial<BlockData>;
        position?: 'first' | 'last' | number;
    }): Promise<Block>;
}
/**
 * Gets the root block ID for any given block
 * The root block is the topmost parent in the block hierarchy
 * memoization mainly to be able to use this with \`use\` in react components
 */
export declare const getRootBlock: ((block: Block) => Promise<Block>) & import("lodash").MemoizedFunction;
/**
 * Returns the next visible block in the document
 * Order: children first (if not collapsed), then next sibling, then parent's next sibling
 */
export declare const nextVisibleBlock: (block: Block, topLevelBlockId: string) => Promise<Block | null>;
/**
 * Returns the previous visible block in the document
 * Order: previous sibling's last visible descendant, previous sibling, parent
 */
export declare const previousVisibleBlock: (block: Block, topLevelBlockId: string) => Promise<Block | null>;
export declare const getAllChildrenBlocks: (repo: Repo, blockId: string) => Promise<BlockData[]>;


The component will be transpiled and executed in the browser. It should export a default React component.
Here's the basic structure your code should follow:

\`\`\`tsx
import { DefaultBlockRenderer } from "@/components/renderer/DefaultBlockRenderer.js";

const CustomContentRenderer = ({ block }: BlockRendererProps) => {
  const blockData = block.use();
  if (!blockData) return null;
  
  // Your renderer implementation here
  
  return (
    <div className="custom-renderer">
      {/* Your rendering logic here */}
    </div>
  );
};

const CustomRenderer = () => (props) => <DefaultBlockRenderer {...props} ContentRenderer={CustomContentRenderer}/>

// Optionally define when this renderer should be used
CustomRenderer.canRender = ({ block }: BlockRendererProps) => {
  const data = block.dataSync();
  return data?.properties.type === '${options.rendererName || 'custom'}';
};

// Higher priority means this renderer will be chosen over others
CustomRenderer.priority = () => 10;

export default CustomRenderer;
\`\`\`

Return ONLY the component code without any explanations or markdown formatting.
`

  const userPrompt =
    `Please create a custom renderer component for the following content:
    
    ${(blockData.content)}
    
    ${options.includeChildren ? `\nThe block also has the following children:\n${childrenContent}` : ''}
    
    Please analyze the content and create a renderer that presents it in the most appropriate way.
    Return ONLY the component code without any explanations or markdown formatting.
    
    ${options.customPrompt}
    `

  const messages: Message[] = [
    {role: 'system', content: systemPrompt},
    {role: 'user', content: userPrompt},
  ]

  try {
    const requestBody = {
      model: config.model,
      messages,
      temperature: 0.7,
      max_tokens: 50000,
    }
    console.log('Request body:', requestBody)
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Omniliner Renderer Generator',
      },
      body: JSON.stringify(requestBody),
    })

    console.log({response})
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenRouter API error: ${response.status} ${errorText}`)
    }

    const data = await response.json() as OpenRouterResponse
    if ('error' in data) {
      throw new Error(`OpenRouter API error: ${data.error.message}`)
    }
    console.log('Claude response:', data)
    const rendererCode = data.choices[0]?.message.content.trim()

    // Extract only the code from possible markdown code blocks
    const codeMatch = rendererCode.match(/```tsx?([\s\S]*?)```/) ||
      rendererCode.match(/```jsx?([\s\S]*?)```/) ||
      rendererCode.match(/```([\s\S]*?)```/)

    return codeMatch ? codeMatch[1].trim() : rendererCode
  } catch (error) {
    console.error('Error calling Claude API via OpenRouter:', error)
    throw error
  }
}
