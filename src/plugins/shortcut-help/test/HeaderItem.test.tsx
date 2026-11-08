// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { accountHeaderPlugin } from '@/plugins/account-header'
import { systemStatusPlugin } from '@/plugins/system-status'
import { workspaceHeaderPlugin } from '@/plugins/workspace-header'
import { ShortcutHelpHeaderItem, shortcutHelpHeaderItem, shortcutHelpPlugin } from '../index.ts'
import { shortcutHelpToggle } from '../toggleStore.ts'

afterEach(() => {
  cleanup()
  shortcutHelpToggle.close()
})

describe('shortcut help header item', () => {
  it('registers in the end region and opens the overlay from its accessible button', () => {
    const runtime = resolveFacetRuntimeSync(shortcutHelpPlugin)
    const item = runtime.read(headerItemsFacet).find(({id}) => id === shortcutHelpHeaderItem.id)

    expect(item).toEqual(shortcutHelpHeaderItem)
    expect(item?.region).toBe('end')

    render(<ShortcutHelpHeaderItem/>)
    const button = screen.getByRole('button', {name: 'Help'})

    expect(button).not.toHaveClass('hidden')
    expect(shortcutHelpToggle.isOpen()).toBe(false)
    fireEvent.click(button)
    expect(shortcutHelpToggle.isOpen()).toBe(true)
  })

  it('places Help between workspace controls and system status/account controls', () => {
    const runtime = resolveFacetRuntimeSync([
      workspaceHeaderPlugin,
      shortcutHelpPlugin,
      systemStatusPlugin,
      accountHeaderPlugin,
    ])

    expect(runtime.read(headerItemsFacet).map(({id}) => id)).toEqual([
      'workspace-header.pending-invitations',
      'shortcut-help.header',
      'system-status.header',
      'account-header.user-menu',
    ])
  })
})
