import { LayoutRenderer, layoutRendererRegistration } from '@/components/renderer/LayoutRenderer.js'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
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

// Same id as the host's layout renderer, at the precedence the host holds:
// among registrations sharing an id only the strongest survives, and an
// equal precedence goes to whoever registered later (extensions register
// after core). Reusing the host's resolve keeps the gate identical too —
// only the component differs.
export default blockRendererFacet.of({
  id: 'layout',
  label: 'Panel layout (demo)',
  resolve: (ctx) =>
    layoutRendererRegistration.resolve?.(ctx) ? { render: DemoLayoutRenderer } : null,
}, { precedence: 20 })
