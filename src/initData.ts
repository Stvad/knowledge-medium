import { BlockData } from '@/types.ts'
import { v4 as uuidv4 } from 'uuid'

export function getExampleBlocks(): BlockData[] {
  const rootId = uuidv4()
  const child1Id = uuidv4()
  const child2Id = uuidv4()
  const child3Id = uuidv4()

  const defaults = {
    properties: {},
    childIds: [],
    createTime: Date.now(),
    updateTime: Date.now(),
  }

  return [
    {
      ...defaults,
      id: rootId,
      content: 'Hello World\nThis is a multiline\ntext block',
      childIds: [child1Id, child2Id, child3Id],
    },
    {
      ...defaults,
      id: child1Id,
      content: 'A normal text block\nwith multiple lines',
      parentId: rootId,
    },
    {
      ...defaults,
      id: child2Id,
      content: `import { DefaultBlockRenderer } from "@/components/DefaultBlockRenderer"; 
 
function ContentRenderer({ block, changeBlock }) {
    return <div style={{ color: "green" }}>
        Custom renderer for: {block.content}
        <button onClick={() => changeBlock(block => block.content = block.content + '!')}>
            Add !
        </button>
    </div>
}


// By default, renderer is responsible for rendering everything in the block (including controls/etc), 
// but we often want to just update how content of the block is rendered and leave everything else untouched, 
// Here is an example of doing that
export default ({ block, changeBlock }) => <DefaultBlockRenderer block={block} changeBlock={changeBlock} ContentRenderer={ContentRenderer}/> 
`,
      properties: {type: 'renderer'},
      parentId: rootId,
    },
    {
      ...defaults,
      id: child3Id,
      content: 'This block uses the custom renderer',
      // todo import wont' update this rn, so need to manually set the new renderer id
      //  generally unclear how to handle this for (arbitrary field that contains id of another block)
      //  plausibly the type should define how to extract the references from property/provide function
      properties: {renderer: child2Id},
      parentId: rootId,
    },
  ]
}
