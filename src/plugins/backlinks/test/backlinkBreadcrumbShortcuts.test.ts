// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { isCollapsedProp } from '@/data/properties.js'
import {
  BACKLINK_ENTRY_ACTION_CONTEXT,
  BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY,
  backlinkEntryShortcutActivation,
  createBacklinkBreadcrumbExpansionGate,
  expandNextCollapsedBreadcrumbAction,
  findNextCollapsedBreadcrumb,
  openNextCollapsedBreadcrumb,
  openNextCollapsedBreadcrumbOnce,
  type BacklinkEntryShortcutController,
} from '../backlinkBreadcrumbShortcuts.ts'

const fakeBlock = (id: string, collapsed: boolean): Block => ({
  id,
  peekProperty: (schema: unknown) => schema === isCollapsedProp ? collapsed : undefined,
  set: vi.fn(),
}) as unknown as Block

const mutableFakeBlock = (id: string, collapsed: boolean): Block => {
  let nextCollapsed = collapsed
  return {
    id,
    peekProperty: (schema: unknown) => schema === isCollapsedProp ? nextCollapsed : undefined,
    set: vi.fn(async (schema: unknown, value: unknown) => {
      if (schema === isCollapsedProp && typeof value === 'boolean') {
        nextCollapsed = value
      }
    }),
  } as unknown as Block
}

describe('backlink breadcrumb shortcuts', () => {
  it('targets the closest collapsed breadcrumb to the backlink block', () => {
    const root = fakeBlock('root', true)
    const section = fakeBlock('section', false)
    const immediate = fakeBlock('immediate', true)

    expect(findNextCollapsedBreadcrumb([root, section, immediate])).toBe(immediate)
  })

  it('opens the next collapsed breadcrumb and expands it', async () => {
    const root = fakeBlock('root', true)
    const immediate = fakeBlock('immediate', true)
    const setShownBlockId = vi.fn()

    await expect(openNextCollapsedBreadcrumb([root, immediate], setShownBlockId))
      .resolves.toBe(true)

    expect(immediate.set).toHaveBeenCalledExactlyOnceWith(isCollapsedProp, false)
    expect(root.set).not.toHaveBeenCalled()
    expect(setShownBlockId).toHaveBeenCalledExactlyOnceWith('immediate')
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

  it('keeps key-repeat filtering out of the action layer', async () => {
    const expandNextCollapsedBreadcrumb = vi.fn()

    await expandNextCollapsedBreadcrumbAction.handler({
      block: fakeBlock('focused', false),
      uiStateBlock: fakeBlock('ui', false),
      expandNextCollapsedBreadcrumb,
      hasCollapsedBreadcrumb: () => true,
    } as never, {repeat: true} as KeyboardEvent)

    expect(expandNextCollapsedBreadcrumb).toHaveBeenCalledOnce()
  })

  it('dedupes duplicate expansion attempts against the same rendered parent chain', async () => {
    const root = mutableFakeBlock('root', true)
    const immediate = mutableFakeBlock('immediate', true)
    const parents = [root, immediate]
    const gate = createBacklinkBreadcrumbExpansionGate()
    const setShownBlockId = vi.fn()

    await expect(openNextCollapsedBreadcrumbOnce(gate, parents, setShownBlockId))
      .resolves.toBe(true)
    await expect(openNextCollapsedBreadcrumbOnce(gate, parents, setShownBlockId))
      .resolves.toBe(false)

    expect(immediate.set).toHaveBeenCalledExactlyOnceWith(isCollapsedProp, false)
    expect(root.set).not.toHaveBeenCalled()
    expect(setShownBlockId).toHaveBeenCalledExactlyOnceWith('immediate')
  })

  it('allows the next expansion after the breadcrumb chain re-renders', async () => {
    const root = mutableFakeBlock('root', true)
    const immediate = mutableFakeBlock('immediate', true)
    const initialParents = [root, immediate]
    const rerenderedParents = [root]
    const gate = createBacklinkBreadcrumbExpansionGate()
    const setShownBlockId = vi.fn()

    await openNextCollapsedBreadcrumbOnce(gate, initialParents, setShownBlockId)
    await expect(openNextCollapsedBreadcrumbOnce(gate, rerenderedParents, setShownBlockId))
      .resolves.toBe(true)

    expect(immediate.set).toHaveBeenCalledExactlyOnceWith(isCollapsedProp, false)
    expect(root.set).toHaveBeenCalledExactlyOnceWith(isCollapsedProp, false)
    expect(setShownBlockId).toHaveBeenCalledTimes(2)
    expect(setShownBlockId).toHaveBeenLastCalledWith('root')
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

  it('activates for focused backlink CodeMirror surfaces while editing', () => {
    const controller: BacklinkEntryShortcutController = {
      expandNextCollapsedBreadcrumb: vi.fn(),
      hasCollapsedBreadcrumb: () => true,
    }

    const activations = backlinkEntryShortcutActivation({
      surface: 'codemirror',
      inFocus: true,
      inEditMode: true,
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
      surface: 'codemirror',
      inFocus: true,
      inEditMode: false,
      isSelected: false,
      block: fakeBlock('focused', false),
      blockContext: {
        isBacklink: true,
        [BACKLINK_ENTRY_SHORTCUT_CONTROLLER_KEY]: controller,
      },
    } as never)).toBeNull()
  })
})
