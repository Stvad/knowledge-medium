// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockRenderer } from '@/types.js'
import { useBlockContext } from '@/context/block.js'
import { BlockInfoDialog } from '../BlockInfoDialog.tsx'

afterEach(cleanup)

// Probe section: surfaces the panelId the section resolves from ambient
// BlockContext, so the test can assert the dialog re-seeds it (DialogHost
// mounts the dialog outside the panel tree).
const PanelProbe: BlockRenderer = () => {
  const {panelId} = useBlockContext()
  return <span data-testid="panel">{panelId ?? 'none'}</span>
}

const noop = () => {}
const block = {id: 'b1'} as Block

describe('BlockInfoDialog', () => {
  it('seeds the originating panelId into its sections', () => {
    render(
      <BlockInfoDialog
        block={block}
        sections={[PanelProbe]}
        panelId="panel-x"
        resolve={noop}
        cancel={noop}
      />,
    )
    expect(screen.getByTestId('panel').textContent).toBe('panel-x')
  })

  it('degrades to no panel when opened without one', () => {
    render(
      <BlockInfoDialog
        block={block}
        sections={[PanelProbe]}
        resolve={noop}
        cancel={noop}
      />,
    )
    expect(screen.getByTestId('panel').textContent).toBe('none')
  })
})
