// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import {
  BACKLINK_ENTRY_ACTION_CONTEXT,
  BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY,
  backlinkEntryShortcutActivation,
  promoteClosestBreadcrumb,
  promoteClosestBreadcrumbAction,
  type BacklinkEntryShortcutController,
} from '../backlinkBreadcrumbShortcuts.ts'

const fakeBlock = (id: string): Block => ({ id }) as unknown as Block

describe('backlink breadcrumb shortcuts', () => {
  it('promotes the rightmost breadcrumb segment to be the shown block', () => {
    const root = fakeBlock('root')
    const section = fakeBlock('section')
    const immediate = fakeBlock('immediate')
    const setShownBlockId = vi.fn()

    expect(promoteClosestBreadcrumb([root, section, immediate], setShownBlockId)).toBe(true)
    expect(setShownBlockId).toHaveBeenCalledExactlyOnceWith('immediate')
  })

  it('no-ops when there are no breadcrumb segments', () => {
    const setShownBlockId = vi.fn()

    expect(promoteClosestBreadcrumb([], setShownBlockId)).toBe(false)
    expect(setShownBlockId).not.toHaveBeenCalled()
  })

  it('delegates the action to the backlink entry controller', async () => {
    const promote = vi.fn()

    await promoteClosestBreadcrumbAction.handler({
      block: fakeBlock('focused'),
      uiStateBlock: fakeBlock('ui'),
      promoteClosestBreadcrumb: promote,
      hasBreadcrumb: () => true,
    } as never, {} as KeyboardEvent)

    expect(promote).toHaveBeenCalledOnce()
  })

  it('activates only for focused backlink block surfaces with a controller', () => {
    const controller: BacklinkEntryShortcutController = {
      promoteClosestBreadcrumb: vi.fn(),
      hasBreadcrumb: () => true,
    }

    const activations = backlinkEntryShortcutActivation({
      surface: 'block',
      inFocus: true,
      inEditMode: false,
      isSelected: false,
      block: fakeBlock('focused'),
      blockContext: {
        isBacklink: true,
        [BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]: controller,
      },
    } as never)

    expect(activations).toEqual([{
      context: BACKLINK_ENTRY_ACTION_CONTEXT,
      dependencies: {
        block: expect.objectContaining({id: 'focused'}),
        promoteClosestBreadcrumb: controller.promoteClosestBreadcrumb,
        hasBreadcrumb: controller.hasBreadcrumb,
      },
    }])

    expect(backlinkEntryShortcutActivation({
      surface: 'block',
      inFocus: true,
      inEditMode: false,
      isSelected: false,
      block: fakeBlock('focused'),
      blockContext: {},
    } as never)).toBeNull()
  })
})
