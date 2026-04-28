// Authoring sources for the example extensions seeded into a fresh
// tutorial workspace and inserted on demand by the
// `insert_example_extensions` action.
//
// Each entry is an ESM module text whose `default` export is an
// AppExtension — see dynamicExtensions.ts for the contract. Imports
// resolve through the page-global importmap, so `@/extensions/api.js`
// returns the same module instance the running app uses.
//
// Renderer-bearing examples register a renderer via blockRenderersFacet
// and compose with the default block chrome by delegating to
// DefaultBlockRenderer with a custom ContentRenderer prop — same shape
// as plugins/video-player/VideoPlayerRenderer. The block keeps its
// bullet, children, properties, and edit affordances; only the
// content area is customized.

import type { Block } from '@/data/block.ts'
import { typeProp } from '@/data/properties.ts'

export interface ExampleExtensionDefinition {
  /** Stable, kebab-case label used in commit history and source attribution. */
  id: string
  /** ESM module text. */
  source: string
}

const HELLO_RENDERER_SOURCE = `import { blockRenderersFacet } from '@/extensions/api.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'

// Property-keyed renderer: any block with property 'renderer: hello-renderer'
// routes here directly via the registry. The renderer delegates to
// DefaultBlockRenderer so the bullet, children, properties, and edit
// affordances all keep working — we just supply a custom ContentRenderer
// for the content area.

const HelloContent = ({ block }) => (
  <div style={{ padding: 8, border: '1px dashed #888', borderRadius: 4 }}>
    <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
      hello-renderer custom content area:
    </div>
    <em>{block.dataSync()?.content}</em>
  </div>
)

const HelloRenderer = (props) =>
  <DefaultBlockRenderer {...props} ContentRenderer={HelloContent} />

export default blockRenderersFacet.of({
  id: 'hello-renderer',
  renderer: HelloRenderer,
})
`

const FOLD_ALL_ACTION_SOURCE = `import {
  actionsFacet,
  ActionContextTypes,
  getActivePanelBlock,
  isCollapsedProp,
  topLevelBlockIdProp,
} from '@/extensions/api.js'

// Toggle collapse on every visible descendant of the top-level block.
// Demonstrates a single action contribution with a default keybinding.
//
// GLOBAL action handlers receive the user-level ui-state block; the
// per-panel topLevelBlockId / focusedBlockId live on each panel's own
// block under ui-state/panels. getActivePanelBlock walks there for us.
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
    const panel = await getActivePanelBlock(uiStateBlock)
    const topLevelId = (await panel?.data())?.properties[topLevelBlockIdProp.name]?.value
    if (!topLevelId) return

    const repo = uiStateBlock.repo
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
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'

// Multi-facet plugin: an action, a click handler, and a data-keyed
// renderer that appends the block's reactions (stored under
// properties['user:reactions']) below the content. The renderer claims
// the block via canRender when reactions exist, then delegates to
// DefaultBlockRenderer with a wrapping ContentRenderer.
//
// Tradeoff vs property-keyed (e.g. hello-renderer): canRender competes
// with other plugin renderers — if a block has property
// 'renderer: hello-renderer' AND reactions, the property route wins
// and the reactions don't show. For cross-cutting decoration that
// always layers on top, you'd need a different facet (or to fold the
// decoration into a base content renderer).

const EMOJI_OPTIONS = ['🔥', '👍', '🎉', '❤️']

const ReactionsRow = ({ reactions }) => (
  <div style={{ display: 'flex', gap: 4, fontSize: 14, marginTop: 4 }}>
    {reactions.map((emoji, i) => <span key={i}>{emoji}</span>)}
  </div>
)

const ReactionsContent = ({ block }) => {
  const data = block.dataSync()
  const reactions = data?.properties['user:reactions']?.value ?? []
  return (
    <div>
      <em>{data?.content}</em>
      <ReactionsRow reactions={reactions} />
    </div>
  )
}

const ReactionsRenderer = (props) =>
  <DefaultBlockRenderer {...props} ContentRenderer={ReactionsContent} />
ReactionsRenderer.canRender = ({ block }) => {
  const reactions = block.dataSync()?.properties['user:reactions']?.value
  return Array.isArray(reactions) && reactions.length > 0
}
// Below the default canRender priority for plugin renderers (e.g.
// video-player at 5), so a video block with reactions still renders
// as a video.
ReactionsRenderer.priority = () => 1

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
    renderer: ReactionsRenderer,
  }),
]
`

const KUDOS_FACET_SOURCE = `import { defineFacet, blockRenderersFacet } from '@/extensions/api.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'

// Demonstrates defining a brand-new facet inside an extension block,
// contributing to it from the same block, and registering a
// property-keyed renderer ('renderer: kudos-banner') that delegates to
// DefaultBlockRenderer with a wrapping ContentRenderer.
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

const KudosBannerContent = ({ block }) => (
  <div>
    <em>{block.dataSync()?.content}</em>
    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
      Kudos facet defined. (Other extensions can contribute to user.kudos.)
    </div>
  </div>
)

const KudosBannerRenderer = (props) =>
  <DefaultBlockRenderer {...props} ContentRenderer={KudosBannerContent} />

export default [
  kudosFacet.of({ from: 'self', message: 'Hello from the defining block' }),
  blockRenderersFacet.of({
    id: 'kudos-banner',
    renderer: KudosBannerRenderer,
  }),
]
`

export const exampleExtensions: readonly ExampleExtensionDefinition[] = [
  {id: 'hello-renderer', source: HELLO_RENDERER_SOURCE},
  {id: 'fold-all-action', source: FOLD_ALL_ACTION_SOURCE},
  {id: 'emoji-react', source: EMOJI_REACT_SOURCE},
  {id: 'kudos-facet', source: KUDOS_FACET_SOURCE},
]

export const TUTORIAL_README = `Welcome — this is a malleable thought medium.

Below are example **extension blocks** (\`type: extension\`) that show the kinds of things you can build:

- **hello-renderer** — wraps the primary content renderer (no replacement of the host block).
- **fold-all-action** — an action with a default keyboard shortcut.
- **emoji-react** — a multi-facet plugin (decorating content renderer + click handler + action).
- **kudos-facet** — defines a brand-new facet and decorates the content with a banner.

To author your own:
1. Create a block with property \`type = extension\`.
2. Set its content to a TS/JSX module whose \`default\` export is an \`AppExtension\` — a FacetContribution, an array, or a function returning one.
3. Import what you need from \`@/extensions/api.js\` (\`Object.keys(km)\` to discover; or check the agent bridge's describeRuntime).
4. Run the "Reload extensions" command (Cmd-K) to apply changes after editing.

To re-insert these examples beside any block, run **Insert example extensions** from the command palette.

To turn an extension off without deleting it, set its \`system:disabled\` property to true.`

/**
 * Append the example-extension blocks under `parentBlock`. Used by the
 * `insert_example_extensions` command to re-seed examples in any
 * workspace without rebuilding the user.
 */
export const insertExampleExtensionsUnder = async (
  parentBlock: Block,
): Promise<Block[]> => {
  const created: Block[] = []
  for (const example of exampleExtensions) {
    const child = await parentBlock.createChild({
      data: {
        content: example.source,
        properties: {type: {...typeProp, value: 'extension'}},
      },
    })
    created.push(child)
  }
  return created
}
