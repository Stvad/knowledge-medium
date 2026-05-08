// Authoring sources for the example extensions seeded into a fresh
// tutorial workspace and inserted on demand by the
// `insert_example_extensions` NORMAL_MODE action.
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

import type { Block } from '../data/block'
import { ChangeScope } from '@/data/api'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { createChild } from '@/data/internals/kernelMutators'
import { extensionDisabledProp } from '@/data/properties'

export interface ExampleExtensionDefinition {
  /** Stable, kebab-case label used in commit history and source attribution. */
  id: string
  /** ESM module text. */
  source: string
  /** Seed/insert this extension with `system:disabled = true`. */
  disabledByDefault?: boolean
}

const HELLO_RENDERER_SOURCE = `import {
  blockContentRendererFacet,
  ChangeScope,
  codecs,
  defineProperty,
  defineVariant,
  propertySchemasFacet,
} from '@/extensions/api.js'

// Variant on blockContentRendererFacet: contributes an alternative
// content renderer for blocks tagged 'user:hello = true'. Returning
// null for everything else lets ordinary blocks fall through to the
// host's primary renderer. The bullet, children, properties, and
// edit affordances keep working because the variant only swaps the
// content area inside DefaultBlockRenderer — the rest of the block
// chrome is untouched.

const helloProp = defineProperty('user:hello', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const HelloContent = ({ block }) => (
  <div style={{ padding: 8, border: '1px dashed #888', borderRadius: 4 }}>
    <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
      hello-renderer custom content area:
    </div>
    <em>{block.peek()?.content}</em>
  </div>
)

export default [
  // Register the schema so the value-preset / property-editor lookups
  // can find this prop, and describeRuntime can list it.
  propertySchemasFacet.of(helloProp),
  blockContentRendererFacet.of((ctx) => {
    if (!ctx.block.peekProperty(helloProp)) return null
    return defineVariant('user.hello', 'Hello', HelloContent)
  }),
]
`

const FOLD_ALL_ACTION_SOURCE = `import {
  actionsFacet,
  ActionContextTypes,
  ChangeScope,
  isCollapsedProp,
  topLevelBlockIdProp,
} from '@/extensions/api.js'

// Toggle collapse on every visible descendant of the top-level block.
// Demonstrates a single action contribution with a default keybinding.
//
// NORMAL_MODE handlers receive the panel's ui-state block (panel-bound)
// directly as uiStateBlock, so the per-panel topLevelBlockId is reachable
// without walking into ui-state/panels.
//
// Note on key syntax: this app uses hotkeys-js, which has no 'mod'
// alias — list cmd and ctrl variants explicitly for cross-platform
// support.
export default actionsFacet.of({
  id: 'user.fold-all',
  description: 'Fold/unfold every block in the current view',
  context: ActionContextTypes.NORMAL_MODE,
  defaultBinding: { keys: ['cmd+shift+f', 'ctrl+shift+f'] },
  handler: async ({ uiStateBlock }) => {
    const topLevelId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    if (!topLevelId) return

    const repo = uiStateBlock.repo
    // repo.query.subtree hydrates the cache for every visited row, so per-block
    // peekProperty reads below are sync. The root is included in the subtree
    // and filtered out at the consumer boundary so the subtree query stays
    // includeRoot=true (the only shape we keep going forward).
    const subtreeWithRoot = await repo.query.subtree({id: topLevelId}).load()
    const subtree = subtreeWithRoot.filter(d => d.id !== topLevelId)
    // If anything is uncollapsed, collapse all; otherwise expand all.
    const anyExpanded = subtree.some(
      data => repo.block(data.id).peekProperty(isCollapsedProp) !== true,
    )
    await repo.tx(async tx => {
      for (const data of subtree) {
        await tx.setProperty(data.id, isCollapsedProp, anyExpanded)
      }
    }, { scope: ChangeScope.BlockDefault, description: 'fold all' })
  },
})
`

const EMOJI_REACT_SOURCE = `import {
  actionsFacet,
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  ActionContextTypes,
  ChangeScope,
  codecs,
  defineProperty,
  isSelectionClick,
  propertySchemasFacet,
} from '@/extensions/api.js'

// Multi-facet plugin: an action, a click handler, and a content
// decorator that layers a reactions row (stored under property
// 'user:reactions') below whatever the block already renders —
// markdown, video player, edit-mode CodeMirror, or another custom
// renderer. Decorators stack on top of the chosen content renderer,
// so a video block with reactions shows both, and a block with a
// custom 'renderer: hello-renderer' property still gets its reactions
// row.

const reactionsProp = defineProperty('user:reactions', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const EMOJI_OPTIONS = ['🔥', '👍', '🎉', '❤️']

const ReactionsRow = ({ reactions }) => (
  <div style={{ display: 'flex', gap: 4, fontSize: 14, marginTop: 4 }}>
    {reactions.map((emoji, i) => <span key={i}>{emoji}</span>)}
  </div>
)

const cycleReaction = async (block) => {
  const current = block.peekProperty(reactionsProp) ?? []
  const nextEmoji = EMOJI_OPTIONS[current.length % EMOJI_OPTIONS.length]
  await block.set(reactionsProp, [...current, nextEmoji])
}

export default [
  // Register the schema so the codec/editor lookups know about this
  // property and describeRuntime can list it.
  propertySchemasFacet.of(reactionsProp),

  // Click on a block while holding Alt to add a reaction.
  blockClickHandlersFacet.of((ctx) => (event) => {
    if (!event.altKey) return
    if (isSelectionClick(event)) return
    event.preventDefault()
    event.stopPropagation()
    void cycleReaction(ctx.block)
  }),

  // Same operation as a keyboard action.
  actionsFacet.of({
    id: 'user.add-reaction',
    description: 'Add a reaction emoji to the focused block',
    context: ActionContextTypes.NORMAL_MODE,
    defaultBinding: { keys: ['cmd+shift+r', 'ctrl+shift+r'] },
    handler: async ({ block }) => cycleReaction(block),
  }),

  blockContentDecoratorsFacet.of((ctx) => {
    const reactions = ctx.block.peekProperty(reactionsProp)
    if (!Array.isArray(reactions) || reactions.length === 0) return null

    return (Inner) => {
      const Decorated = (props) => (
        <div>
          <Inner {...props} />
          <ReactionsRow reactions={reactions} />
        </div>
      )
      return Decorated
    }
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
    <em>{block.peek()?.content}</em>
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

const SPLIT_LAYOUT_SOURCE = `import {
  blockLayoutFacet,
  ChangeScope,
  codecs,
  defineProperty,
  defineVariant,
  propertySchemasFacet,
} from '@/extensions/api.js'

// blockLayoutFacet contributions arrange the four slots (Content,
// Properties, Children, Footer) inside a block's body. Each slot is
// already wrapped in its own ErrorBoundary + interaction provider
// boundary, so swapping the layout doesn't change shortcut-surface
// scoping or accidentally nest descendant blocks inside the parent's
// content surface.
//
// Compose with content renderers freely: a block can have a custom
// 'renderer: hello-renderer' AND a custom layout — the layout just
// arranges the slots; the slots' insides are still resolved through
// the rest of the registry.

const layoutProp = defineProperty('user:layout', {
  codec: codecs.string,
  changeScope: ChangeScope.BlockDefault,
})

const SplitLayout = ({ Content, Children, Properties, Footer }) => (
  <div>
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Content />
        {Properties && <Properties />}
      </div>
      <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #444', paddingLeft: 12 }}>
        <Children />
      </div>
    </div>
    <Footer />
  </div>
)

// Apply side-by-side layout to any block whose 'user:layout' property
// is 'split'. Returning null for everything else lets ordinary blocks
// fall through to the default vertical layout.
//
// blockLayoutFacet is a variant facet — contributions return
// {id, label, render} (or use defineVariant() sugar) so a future
// picker UI could enumerate them. Returning null still means "this
// variant doesn't apply here".
export default [
  // Register the schema so describeRuntime / property-editor lookups
  // know about this property.
  propertySchemasFacet.of(layoutProp),
  blockLayoutFacet.of((ctx) => {
    if (ctx.block.peekProperty(layoutProp) !== 'split') return null
    return defineVariant('split', 'Split (content / children)', SplitLayout)
  }),
]
`

const LAYOUT_RENDERER_OVERRIDE_SOURCE = `import { blockRenderersFacet } from '@/extensions/api.js'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.js'

// Disabled by default because this replaces the app-wide renderer
// registered under id 'layout'. Enable it to see how a dynamic
// extension can wrap the host layout while preserving the original
// LayoutRenderer's matching rules.

const DemoLayoutRenderer = (props) => (
  <div style={{
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    height: '100%',
    minWidth: 0,
  }}>
    <div style={{
      padding: '4px 8px',
      borderBottom: '1px solid #444',
      color: '#888',
      fontSize: 12,
    }}>
      layout renderer override active
    </div>
    <LayoutRenderer {...props} />
  </div>
)

DemoLayoutRenderer.canRender = LayoutRenderer.canRender
DemoLayoutRenderer.priority = LayoutRenderer.priority

export default blockRenderersFacet.of({
  id: 'layout',
  renderer: DemoLayoutRenderer,
})
`

const DEFAULT_RENDERER_OVERRIDE_SOURCE = `import { blockRenderersFacet } from '@/extensions/api.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'

// Disabled by default because this replaces the fallback renderer
// registered under id 'default'. Enable it to change one small
// behavior for every ordinary block that falls through to the default:
// empty blocks render a muted read-mode placeholder while edit mode,
// children, properties, bullets, and selection chrome stay unchanged.

const PlaceholderContent = ({ block }) => {
  const content = block.peek()?.content ?? ''
  if (content.trim().length === 0) {
    return (
      <div style={{ minHeight: '1.7em', color: '#888', fontStyle: 'italic' }}>
        empty block
      </div>
    )
  }

  return <MarkdownContentRenderer block={block} />
}

const PlaceholderDefaultRenderer = (props) => (
  <DefaultBlockRenderer {...props} ContentRenderer={PlaceholderContent} />
)

export default blockRenderersFacet.of({
  id: 'default',
  renderer: PlaceholderDefaultRenderer,
})
`

export const exampleExtensions: readonly ExampleExtensionDefinition[] = [
  {id: 'hello-renderer', source: HELLO_RENDERER_SOURCE},
  {id: 'fold-all-action', source: FOLD_ALL_ACTION_SOURCE},
  {id: 'emoji-react', source: EMOJI_REACT_SOURCE},
  {id: 'kudos-facet', source: KUDOS_FACET_SOURCE},
  {id: 'split-layout', source: SPLIT_LAYOUT_SOURCE},
  {
    id: 'layout-renderer-override',
    source: LAYOUT_RENDERER_OVERRIDE_SOURCE,
    disabledByDefault: true,
  },
  {
    id: 'default-renderer-placeholder',
    source: DEFAULT_RENDERER_OVERRIDE_SOURCE,
    disabledByDefault: true,
  },
]

export const getExampleExtensionInitialProperties = (
  example: ExampleExtensionDefinition,
): Record<string, unknown> | undefined =>
  example.disabledByDefault ? {[extensionDisabledProp.name]: true} : undefined

export const TUTORIAL_README = `Welcome — this is a malleable thought medium.

Below are example **extension blocks** (\`types: ['extension']\`) that show the kinds of things you can build:

- **hello-renderer** — registers a content-renderer variant gated by \`user:hello = true\` (shows the variant-facet pattern).
- **fold-all-action** — an action with a default keyboard shortcut.
- **emoji-react** — a multi-facet plugin (decorating content renderer + click handler + action).
- **kudos-facet** — defines a brand-new facet and decorates the content with a banner.
- **split-layout** — replaces the block layout for blocks tagged \`user:layout = split\`, placing content and children side by side.
- **layout-renderer-override** — disabled by default; overrides the app-wide \`layout\` renderer id and wraps the normal panel layout with a custom frame.
- **default-renderer-placeholder** — disabled by default; overrides the fallback \`default\` renderer id so ordinary empty blocks show a muted read-mode placeholder.

To author your own:
1. Create a block with property \`types = ['extension']\`.
2. Set its content to a TS/JSX module whose \`default\` export is an \`AppExtension\` — a FacetContribution, an array, or a function returning one.
3. Import what you need from \`@/extensions/api.js\` (\`Object.keys(km)\` to discover; or check the agent bridge's describeRuntime).
4. Run the "Reload extensions" command (Cmd-K) to apply changes after editing.

To re-insert these examples beside any block, run **Insert example extensions** from the command palette.

To turn an extension off without deleting it, set its \`system:disabled\` property to true. Some app-wide renderer override examples start disabled; set \`system:disabled\` to false and run "Reload extensions" to try them.`

/**
 * Append the example-extension blocks under `parentBlock`. Used by the
 * `insert_example_extensions` command to re-seed examples in any
 * workspace without rebuilding the user.
 */
export const insertExampleExtensionsUnder = async (
  parentBlock: Block,
): Promise<Block[]> => {
  const repo = parentBlock.repo
  const created: Block[] = []
  const typeSnapshot = repo.snapshotTypeRegistries()
  for (const example of exampleExtensions) {
    const id = await repo.tx(async tx => {
      const childId = await tx.run(createChild, {
        parentId: parentBlock.id,
        content: example.source,
        properties: getExampleExtensionInitialProperties(example),
      })
      await repo.addTypeInTx(tx, childId, EXTENSION_TYPE, {}, typeSnapshot)
      return childId
    }, {scope: ChangeScope.BlockDefault, description: 'insert example extension'})
    created.push(repo.block(id))
  }
  return created
}
