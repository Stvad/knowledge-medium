var e=`import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import {
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  isSelectionClick,
} from '@/extensions/blockInteraction.js'
import { actionsFacet } from '@/extensions/core.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import type { Block } from '@/data/block.js'
import type { BlockRenderer } from '@/types.js'

// Multi-facet plugin: an action, a click handler, and a content
// decorator that layers a reactions row (stored under property
// 'user:reactions') below whatever the block already renders —
// markdown, video player, edit-mode CodeMirror, or another custom
// renderer. Decorators stack on top of the chosen content renderer,
// so a video block with reactions shows both, and a block with a
// custom 'renderer: hello-renderer' property still gets its reactions
// row.

const reactionsProp = seedProperty({
  seedKey: extensionPropertySeedKey('reactions'),
  revision: 1,
  name: 'user:reactions',
  preset: 'string-list',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const EMOJI_OPTIONS = ['🔥', '👍', '🎉', '❤️']

const ReactionsRow = ({ reactions }: { reactions: readonly string[] }) => (
  <div style={{ display: 'flex', gap: 4, fontSize: 14, marginTop: 4 }}>
    {reactions.map((emoji, i) => <span key={i}>{emoji}</span>)}
  </div>
)

const cycleReaction = async (block: Block): Promise<void> => {
  // The UPDATER overload, not peek-then-set. \`peekProperty\` reads the shared
  // pre-transaction cache, so two quick presses — or a peer's reaction syncing
  // in between the read and the write — both compute from the same stale list
  // and the second write drops the first. The updater runs inside the
  // serialized write transaction, against the committed value.
  await block.set(reactionsProp, current => {
    const list = current ?? []
    return [...list, EMOJI_OPTIONS[list.length % EMOJI_OPTIONS.length]]
  })
}

const addReactionAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'user.add-reaction',
  description: 'Add a reaction emoji to the focused block',
  context: ActionContextTypes.NORMAL_MODE,
  // $mod+Shift+e — $mod+Shift+r collides with SRS "Open review"
  // (Control+Shift+r) on Linux/Windows, where $mod is Ctrl. Use a free chord.
  defaultBinding: { keys: '$mod+Shift+e' },
  handler: async ({ block }) => cycleReaction(block),
}

export default [
  // Register the schema so the codec/editor lookups know about this
  // property and describeRuntime can list it.
  definitionSeedsFacet.of(reactionsProp),

  // Click on a block while holding Alt to add a reaction.
  blockClickHandlersFacet.of((ctx) => (event) => {
    if (!event.altKey) return
    if (isSelectionClick(event)) return
    event.preventDefault()
    event.stopPropagation()
    void cycleReaction(ctx.block)
  }),

  // Same operation as a keyboard action.
  actionsFacet.of(addReactionAction),

  blockContentDecoratorsFacet.of((ctx) => {
    const reactions = ctx.block.peekProperty(reactionsProp)
    if (!Array.isArray(reactions) || reactions.length === 0) return null

    return (Inner) => {
      const Decorated: BlockRenderer = (props) => (
        <div>
          <Inner {...props} />
          <ReactionsRow reactions={reactions} />
        </div>
      )
      return Decorated
    }
  }),
]
`;export{e as default};
//# sourceMappingURL=emojiReact.js.map