import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'

// Replaces the fallback renderer registered under id 'default'.
// Inserting this example immediately changes every ordinary block
// that falls through to the default renderer: empty blocks show a
// muted read-mode placeholder while edit mode, children, properties,
// bullets, and selection chrome stay unchanged. Disable the row in
// Extensions settings (or delete the block) to revert.

const PlaceholderContent: BlockRenderer = ({ block }: BlockRendererProps) => {
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

const PlaceholderDefaultRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer {...props} ContentRenderer={PlaceholderContent} />
)

// No precedence: the host's 'default' sits at the implicit 0 and an equal
// precedence goes to whoever registered later, so this replaces it. Raising
// it would ALSO lift the default renderer above the ladder above it — the
// not-yet-loaded placeholder at 1, the extension editor at 5 — which is a
// different change than replacing the fallback.
export default blockRendererFacet.of({
  id: 'default',
  label: 'Block',
  render: PlaceholderDefaultRenderer,
})
