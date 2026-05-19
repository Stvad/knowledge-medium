// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { isCollapsedProp } from '@/data/properties.ts'
import {
  BACKLINK_ENTRY_ACTION_CONTEXT,
  BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY,
  backlinkEntryShortcutActivation,
  expandNextCollapsedBreadcrumbAction,
  findNextCollapsedBreadcrumb,
  openNextCollapsedBreadcrumb,
  type BacklinkEntryShortcutController,
} from '../backlinkBreadcrumbShortcuts.ts'

const fakeBlock = (id: string, collapsed: boolean): Block => ({
  id,
  peekProperty: (schema: unknown) => schema === isCollapsedProp ? collapsed : undefined,
  set: vi.fn(),
}) as unknown as Block

describe('backlink breadcrumb shortcuts', () => {
  it('targets the closest collapsed breadcrumb to the backlink block', () => {
    const root = fakeBlock('root', true)
    const section = fakeBlock('section', false)
    const immediate = fakeBlock('immediate', true)

    expect(findNextCollapsedBreadcrumb([root, section, immediate])).toBe(immediate)
  })

  it('opens the next collapsed breadcrumb and shows it', async () => {
    const root = fakeBlock('root', true)
    const immediate = fakeBlock('immediate', true)
    const showBlock = vi.fn()

    await expect(openNextCollapsedBreadcrumb([root, immediate], showBlock))
      .resolves.toBe(true)

    expect(immediate.set).toHaveBeenCalledExactlyOnceWith(isCollapsedProp, false)
    expect(root.set).not.toHaveBeenCalled()
    expect(showBlock).toHaveBeenCalledExactlyOnceWith('immediate')
  })

  it('awaits the promoted breadcrumb show callback', async () => {
    const calls: string[] = []
    const immediate = fakeBlock('immediate', true)
    immediate.set = vi.fn(async () => {
      calls.push('expand')
    }) as never
    const showBlock = vi.fn(async (blockId: string) => {
      calls.push(`show:${blockId}`)
    })

    await openNextCollapsedBreadcrumb([immediate], showBlock)

    expect(calls).toEqual(['expand', 'show:immediate'])
  })

  it('no-ops when every breadcrumb is already expanded', async () => {
    const setShownBlockId = vi.fn()

    await expect(openNextCollapsedBreadcrumb([fakeBlock('root', false)], setShownBlockId))
      .resolves.toBe(false)

    expect(setShownBlockId).not.toHaveBeenCalled()
  })

  it('delegates the action to the backlink entry controller', async () => {
    const expandNextCollapsedBreadcrumb = vi.fn()

    await expandNextCollapsedBreadcrumbAction.handler({
      block: fakeBlock('focused', false),
      uiStateBlock: fakeBlock('ui', false),
      expandNextCollapsedBreadcrumb,
      hasCollapsedBreadcrumb: () => true,
    } as never, {} as KeyboardEvent)

    expect(expandNextCollapsedBreadcrumb).toHaveBeenCalledOnce()
  })

  it('activates only for focused backlink block surfaces with a controller', () => {
    const controller: BacklinkEntryShortcutController = {
      expandNextCollapsedBreadcrumb: vi.fn(),
      hasCollapsedBreadcrumb: () => true,
    }

    const activations = backlinkEntryShortcutActivation({
      surface: 'block',
      inFocus: true,
      inEditMode: false,
      isSelected: false,
      block: fakeBlock('focused', false),
      blockContext: {
        isBacklink: true,
        [BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]: controller,
      },
    } as never)

    expect(activations).toEqual([{
      context: BACKLINK_ENTRY_ACTION_CONTEXT,
      dependencies: {
        block: expect.objectContaining({id: 'focused'}),
        expandNextCollapsedBreadcrumb: controller.expandNextCollapsedBreadcrumb,
        hasCollapsedBreadcrumb: controller.hasCollapsedBreadcrumb,
      },
    }])

    expect(backlinkEntryShortcutActivation({
      surface: 'block',
      inFocus: true,
      inEditMode: false,
      isSelected: false,
      block: fakeBlock('focused', false),
      blockContext: {},
    } as never)).toBeNull()
  })
})
