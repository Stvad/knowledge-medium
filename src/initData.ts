import { v4 as uuidv4 } from 'uuid'
import { typeProp, rendererProp, aliasProp, fromList } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { dailyPageAliases } from '@/utils/dailyPage'

export type WorkspaceSeedKind = 'tutorial' | 'daily'

// Each seeder customizes the empty root block that
// create_workspace / ensure_personal_workspace seeded server-side.
// repo.create is UPSERT under the hood, so writing the root with the
// already-known id overwrites whatever's there — whether the seed has
// already synced down or not. Children are fresh blocks parented to the
// existing root. The result is exactly one root in the workspace.

// --- Extension example sources ---
//
// Authored as ESM modules whose `default` export is an AppExtension —
// a FacetContribution, an array of contributions, or an async/sync
// function returning either. Imports resolve through the page-global
// importmap, so `@/extensions/api.js` returns the same module instance
// the running app uses.

const HELLO_RENDERER_SOURCE = `import { blockRenderersFacet } from '@/extensions/api.js'

const HelloRenderer = ({ block }) => (
  <div style={{ padding: 8, border: '1px dashed #888', borderRadius: 4 }}>
    Hello from a custom renderer! Block content: <em>{block.dataSync()?.content}</em>
  </div>
)

HelloRenderer.canRender = ({ block }) =>
  block.dataSync()?.properties.renderer?.value === 'hello-renderer'
HelloRenderer.priority = () => 10

export default blockRenderersFacet.of({
  id: 'hello-renderer',
  renderer: HelloRenderer,
})
`

const FOLD_ALL_ACTION_SOURCE = `import { actionsFacet, ActionContextTypes, isCollapsedProp } from '@/extensions/api.js'

// Toggle collapse on every visible descendant of the top-level block.
// Demonstrates a single action contribution with a default keybinding.
//
// Note on key syntax: this app uses hotkeys-js, which has no 'mod'
// alias — list cmd and ctrl variants explicitly for cross-platform
// support.
export default actionsFacet.of({
  id: 'user.fold-all',
  description: 'Fold/unfold every block in the current view',
  context: ActionContextTypes.GLOBAL,
  defaultBinding: { keys: ['cmd+shift+f', 'ctrl+shift+f'] },
  handler: async ({ uiStateBlock }) => {
    const repo = uiStateBlock.repo
    const topLevelId = uiStateBlock.dataSync()?.properties.topLevelBlockId?.value
    if (!topLevelId) return

    const subtree = await repo.getSubtreeBlockData(topLevelId, { includeRoot: false })
    // If anything is uncollapsed, collapse all; otherwise expand all.
    const anyExpanded = subtree.some(b => b.properties[isCollapsedProp.name]?.value !== true)
    for (const data of subtree) {
      const block = repo.find(data.id)
      block.setProperty({ ...isCollapsedProp, value: anyExpanded })
    }
  },
})
`

const EMOJI_REACT_SOURCE = `import {
  actionsFacet,
  blockClickHandlersFacet,
  blockRenderersFacet,
  ActionContextTypes,
  isSelectionClick,
} from '@/extensions/api.js'

// Multi-facet plugin: an action, a click handler, and a content renderer
// that displays the block's reactions stored under properties['user:reactions'].

const EMOJI_OPTIONS = ['🔥', '👍', '🎉', '❤️']

const ReactionsRow = ({ block }) => {
  const data = block.dataSync()
  const reactions = data?.properties['user:reactions']?.value ?? []
  if (!reactions.length) return null
  return (
    <div style={{ display: 'flex', gap: 4, fontSize: 14 }}>
      {reactions.map((emoji, i) => <span key={i}>{emoji}</span>)}
    </div>
  )
}

const ReactionsBlockRenderer = ({ block }) => (
  <div>
    <ReactionsRow block={block} />
  </div>
)
ReactionsBlockRenderer.canRender = ({ block }) =>
  Array.isArray(block.dataSync()?.properties['user:reactions']?.value) &&
  block.dataSync()?.properties['user:reactions'].value.length > 0
ReactionsBlockRenderer.priority = () => 1 // below DefaultBlockRenderer; this is a fragment-style helper

const cycleReaction = (block) => {
  const current = block.dataSync()?.properties['user:reactions']?.value ?? []
  const nextEmoji = EMOJI_OPTIONS[current.length % EMOJI_OPTIONS.length]
  block.change((doc) => {
    doc.properties['user:reactions'] = {
      name: 'user:reactions',
      type: 'list',
      value: [...current, nextEmoji],
    }
  })
}

export default [
  // Click on a block while holding Alt to add a reaction.
  blockClickHandlersFacet.of((ctx) => (event) => {
    if (!event.altKey) return
    if (isSelectionClick(event)) return
    event.preventDefault()
    event.stopPropagation()
    cycleReaction(ctx.block)
  }),

  // Same operation as a keyboard action.
  actionsFacet.of({
    id: 'user.add-reaction',
    description: 'Add a reaction emoji to the focused block',
    context: ActionContextTypes.NORMAL_MODE,
    defaultBinding: { keys: ['cmd+shift+r', 'ctrl+shift+r'] },
    handler: async ({ block }) => cycleReaction(block),
  }),

  blockRenderersFacet.of({
    id: 'reactions-row',
    renderer: ReactionsBlockRenderer,
  }, { source: 'emoji-react' }),
]
`

const REACTIONS_FACET_SOURCE = `import { defineFacet, blockRenderersFacet } from '@/extensions/api.js'

// Demonstrates defining a brand-new facet inside an extension block,
// contributing to it from the same block, and rendering its values.
//
// Other extension blocks can import this same facet by id (a separate
// block can do  defineFacet({ id: 'user.kudos' })  and the FacetRuntime
// will merge contributions across both definitions because it keys by
// id).

const kudosFacet = defineFacet({
  id: 'user.kudos',
  combine: (values) => [...values],
  empty: () => [],
})

const KudosRenderer = ({ block }) => {
  // We can't read facet values from inside a renderer without a runtime
  // hook, so this just displays a fixed banner. The point is to show
  // that defineFacet works inside an extension block.
  return (
    <div style={{ fontSize: 12, color: '#888' }}>
      Kudos facet defined. (Other extensions can contribute to user.kudos.)
    </div>
  )
}
KudosRenderer.canRender = ({ block }) =>
  block.dataSync()?.properties.renderer?.value === 'kudos-banner'
KudosRenderer.priority = () => 10

export default [
  kudosFacet.of({ from: 'self', message: 'Hello from the defining block' }),
  blockRenderersFacet.of({
    id: 'kudos-banner',
    renderer: KudosRenderer,
  }),
]
`

const TUTORIAL_README = `Welcome — this is a malleable thought medium.

Below are example **extension blocks** (\`type: extension\`) that show the kinds of things you can build:

- **hello-renderer** — a single block renderer.
- **fold-all-action** — an action with a default keyboard shortcut.
- **emoji-react** — a multi-facet plugin (renderer + click handler + action).
- **kudos-facet** — a block that defines a brand-new facet.

To author your own:
1. Create a block with property \`type = extension\`.
2. Set its content to a TS/JSX module whose \`default\` export is an \`AppExtension\` — a FacetContribution, an array, or a function returning one.
3. Import what you need from \`@/extensions/api.js\` (\`Object.keys(km)\` to discover; or check the agent bridge's describeRuntime).
4. Run the "Reload extensions" command (Cmd-K) to apply changes after editing.

To turn an extension off without deleting it, set its \`system:disabled\` property to true.`

const seedExtensionBlocks = (
  repo: Repo,
  parentId: string,
  workspaceId: string,
): string[] => {
  const helloId = uuidv4()
  const foldId = uuidv4()
  const emojiId = uuidv4()
  const kudosId = uuidv4()

  repo.create({
    id: helloId,
    workspaceId,
    parentId,
    content: HELLO_RENDERER_SOURCE,
    properties: {type: {...typeProp, value: 'extension'}},
  })
  repo.create({
    id: foldId,
    workspaceId,
    parentId,
    content: FOLD_ALL_ACTION_SOURCE,
    properties: {type: {...typeProp, value: 'extension'}},
  })
  repo.create({
    id: emojiId,
    workspaceId,
    parentId,
    content: EMOJI_REACT_SOURCE,
    properties: {type: {...typeProp, value: 'extension'}},
  })
  repo.create({
    id: kudosId,
    workspaceId,
    parentId,
    content: REACTIONS_FACET_SOURCE,
    properties: {type: {...typeProp, value: 'extension'}},
  })

  return [helloId, foldId, emojiId, kudosId]
}

const seedTutorial = (repo: Repo, rootBlockId: string, workspaceId: string): void => {
  const introId = uuidv4()
  const sampleId = uuidv4()
  const extensionsParentId = uuidv4()

  // Extension subtree first so we know the ids.
  const extensionIds = seedExtensionBlocks(repo, extensionsParentId, workspaceId)

  repo.create({
    id: extensionsParentId,
    workspaceId,
    parentId: rootBlockId,
    content: 'extensions',
    properties: fromList(aliasProp(['extensions'])),
    childIds: extensionIds,
  })

  repo.create({
    id: introId,
    workspaceId,
    parentId: rootBlockId,
    content: TUTORIAL_README,
  })

  repo.create({
    id: sampleId,
    workspaceId,
    parentId: rootBlockId,
    content: 'A block that uses the hello-renderer extension',
    properties: {renderer: {...rendererProp, value: 'hello-renderer'}},
  })

  repo.create({
    id: rootBlockId,
    workspaceId,
    content: 'Welcome',
    childIds: [introId, sampleId, extensionsParentId],
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
