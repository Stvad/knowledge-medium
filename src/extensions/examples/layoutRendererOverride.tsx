import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'

// Replaces the app-wide renderer registered under id 'layout', so
// inserting this example wraps every panel with the custom frame
// below. Disable the row in Extensions settings (or delete the
// block) to revert to the host LayoutRenderer.

const DemoLayoutRenderer: BlockRenderer = (props: BlockRendererProps) => (
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
