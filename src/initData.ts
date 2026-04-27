import { v4 as uuidv4 } from 'uuid'
import { typeProp, rendererProp, aliasProp, fromList } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { dailyPageAliases } from '@/utils/dailyPage'

export type WorkspaceSeedKind = 'tutorial' | 'daily'

const RENDERER_EXAMPLE_SOURCE = `import { DefaultBlockRenderer } from "@/components/DefaultBlockRenderer";

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
`

// Each seeder customizes the empty root block that
// create_workspace / ensure_personal_workspace seeded server-side.
// repo.create is UPSERT under the hood, so writing the root with the
// already-known id overwrites whatever's there — whether the seed has
// already synced down or not. Children are fresh blocks parented to the
// existing root. The result is exactly one root in the workspace.

const seedTutorial = (repo: Repo, rootBlockId: string, workspaceId: string): void => {
  const child1Id = uuidv4()
  const child2Id = uuidv4()
  const child3Id = uuidv4()

  repo.create({
    id: rootBlockId,
    workspaceId,
    content: 'Hello World\nThis is a multiline\ntext block',
    childIds: [child1Id, child2Id, child3Id],
  })
  repo.create({
    id: child1Id,
    workspaceId,
    parentId: rootBlockId,
    content: 'A normal text block\nwith multiple lines',
  })
  repo.create({
    id: child2Id,
    workspaceId,
    parentId: rootBlockId,
    content: RENDERER_EXAMPLE_SOURCE,
    properties: {type: {...typeProp, value: 'renderer'}},
  })
  repo.create({
    id: child3Id,
    workspaceId,
    parentId: rootBlockId,
    content: 'This block uses the custom renderer',
    properties: {renderer: {...rendererProp, value: child2Id}},
  })
}

const seedDailyPage = (repo: Repo, rootBlockId: string, workspaceId: string): void => {
  const [dateLabel, dateIso] = dailyPageAliases(new Date())
  // Empty child bullet so the user has somewhere to type without
  // overwriting the page title (the date) on first keystroke.
  const childBlock = repo.create({
    workspaceId,
    parentId: rootBlockId,
    content: '',
  })
  repo.create({
    id: rootBlockId,
    workspaceId,
    content: dateLabel,
    properties: fromList(aliasProp([dateLabel, dateIso])),
    childIds: [childBlock.id],
  })
}

export const seedNewWorkspace = (
  repo: Repo,
  rootBlockId: string,
  workspaceId: string,
  kind: WorkspaceSeedKind,
): void => {
  switch (kind) {
    case 'tutorial':
      seedTutorial(repo, rootBlockId, workspaceId)
      return
    case 'daily':
      seedDailyPage(repo, rootBlockId, workspaceId)
      return
  }
}
