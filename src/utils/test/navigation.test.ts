import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MouseEvent } from 'react'
import { handleBlockLinkClick, navigate, type NavigateInput } from '@/utils/navigation'
import { panelHistory } from '@/utils/panelHistory'
import { topLevelBlockIdProp } from '@/data/properties'
import { MAIN_PANEL_NAME } from '@/data/globalState'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'

interface FakePanel {
  id: string
  content: string
  topLevelBlockId: string | null
}

const makeRepo = (opts: {
  workspaceId?: string | null
  panels?: FakePanel[]
} = {}): {repo: Repo; setCalls: Array<{id: string; blockId: string}>} => {
  const setCalls: Array<{id: string; blockId: string}> = []
  const panels = new Map<string, FakePanel>()
  for (const p of opts.panels ?? []) panels.set(p.id, {...p})

  const block = (id: string): Block => {
    const peek = () => {
      const p = panels.get(id)
      if (!p) return undefined
      return {properties: {[topLevelBlockIdProp.name]: p.topLevelBlockId}, content: p.content}
    }
    return {
      id,
      peek,
      peekProperty: <T,>(schema: {name: string}) => {
        const p = panels.get(id)
        if (!p) return undefined
        if (schema.name === topLevelBlockIdProp.name) return p.topLevelBlockId as T
        return undefined
      },
      set: async (schema: {name: string}, value: unknown) => {
        if (schema.name === topLevelBlockIdProp.name) {
          const p = panels.get(id)
          if (p) p.topLevelBlockId = value as string
          setCalls.push({id, blockId: value as string})
        }
      },
    } as unknown as Block
  }

  return {
    repo: {
      activeWorkspaceId: opts.workspaceId ?? null,
      block,
    } as unknown as Repo,
    setCalls,
  }
}

const fakeRepo = (workspaceId: string | null = null): Repo =>
  makeRepo({workspaceId}).repo

const captureOpenPanel = (run: () => void): CustomEvent[] => {
  const events: CustomEvent[] = []
  const handler = (e: Event) => { events.push(e as CustomEvent) }
  window.addEventListener('open-panel', handler)
  try {
    run()
  } finally {
    window.removeEventListener('open-panel', handler)
  }
  return events
}

describe('navigate', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  describe("target: 'focused'", () => {
    it('writes URL hash from input workspaceId + blockId', () => {
      navigate(fakeRepo(), {blockId: 'b1', workspaceId: 'w1', target: 'focused'})
      expect(window.location.hash).toBe('#w1/b1')
    })

    it('falls back to repo.activeWorkspaceId when workspaceId is omitted', () => {
      navigate(fakeRepo('w-active'), {blockId: 'b1', target: 'focused'})
      expect(window.location.hash).toBe('#w-active/b1')
    })

    it('input workspaceId wins over repo.activeWorkspaceId', () => {
      navigate(fakeRepo('w-active'), {
        blockId: 'b1',
        workspaceId: 'w-explicit',
        target: 'focused',
      })
      expect(window.location.hash).toBe('#w-explicit/b1')
    })

    it('does nothing when no workspace can be resolved', () => {
      window.location.hash = '#existing'
      navigate(fakeRepo(null), {blockId: 'b1', target: 'focused'})
      expect(window.location.hash).toBe('#existing')
    })

    it('does not dispatch open-panel', () => {
      const events = captureOpenPanel(() => {
        navigate(fakeRepo('w'), {blockId: 'b1', target: 'focused'})
      })
      expect(events).toHaveLength(0)
    })
  })

  describe("target: 'new-panel'", () => {
    it('dispatches open-panel CustomEvent with blockId + sourcePanelId', () => {
      const events = captureOpenPanel(() => {
        navigate(fakeRepo('w-active'), {
          blockId: 'b1',
          target: 'new-panel',
          sourcePanelId: 'panel-a',
        })
      })
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('open-panel')
      expect(events[0].detail).toEqual({blockId: 'b1', sourcePanelId: 'panel-a'})
    })

    it('omits sourcePanelId from detail when not provided', () => {
      const events = captureOpenPanel(() => {
        navigate(fakeRepo('w'), {blockId: 'b1', target: 'new-panel'})
      })
      expect(events).toHaveLength(1)
      expect(events[0].detail).toEqual({blockId: 'b1', sourcePanelId: undefined})
    })

    it('does not write the URL hash', () => {
      window.location.hash = ''
      navigate(fakeRepo('w'), {blockId: 'b1', target: 'new-panel'})
      expect(window.location.hash).toBe('')
    })

    it('does nothing when no workspace can be resolved', () => {
      const events = captureOpenPanel(() => {
        navigate(fakeRepo(null), {blockId: 'b1', target: 'new-panel'})
      })
      expect(events).toHaveLength(0)
    })
  })

  describe("target: 'focused' with panelId routing", () => {
    beforeEach(() => {
      panelHistory.clear('side-panel-1')
      panelHistory.clear('main-panel-1')
    })

    it('writes the URL hash when panelId points at the main panel', () => {
      const {repo, setCalls} = makeRepo({
        workspaceId: 'w-active',
        panels: [{id: 'main-panel-1', content: MAIN_PANEL_NAME, topLevelBlockId: 'b-current'}],
      })
      navigate(repo, {blockId: 'b1', target: 'focused', panelId: 'main-panel-1'})
      expect(window.location.hash).toBe('#w-active/b1')
      // Main panel routes to URL — must NOT mutate topLevelBlockIdProp.
      expect(setCalls).toHaveLength(0)
    })

    it('routes through navigateInPanel when panelId points at a side panel', async () => {
      const {repo, setCalls} = makeRepo({
        workspaceId: 'w-active',
        panels: [{id: 'side-panel-1', content: 'side', topLevelBlockId: 'b-prev'}],
      })
      const before = window.location.hash
      navigate(repo, {blockId: 'b-next', target: 'focused', panelId: 'side-panel-1'})
      // navigateInPanel is async; await microtasks.
      await vi.waitFor(() => expect(setCalls).toHaveLength(1))
      expect(setCalls[0]).toEqual({id: 'side-panel-1', blockId: 'b-next'})
      expect(window.location.hash).toBe(before) // URL untouched for side-panel nav
      expect(panelHistory.getSnapshot('side-panel-1').back).toEqual([{blockId: 'b-prev'}])
    })

    it('falls back to URL hash when panelId is provided but the panel is not loaded', () => {
      // peek() returns undefined for unloaded blocks; treat as "no panel
      // context available" and route through URL rather than no-op.
      const {repo, setCalls} = makeRepo({
        workspaceId: 'w-active',
        panels: [], // panel not registered → peek() returns undefined
      })
      navigate(repo, {blockId: 'b1', target: 'focused', panelId: 'unknown-panel'})
      expect(window.location.hash).toBe('#w-active/b1')
      expect(setCalls).toHaveLength(0)
    })

    it('without panelId, falls back to URL hash (legacy callers)', () => {
      navigate(fakeRepo('w'), {blockId: 'b1', target: 'focused'})
      expect(window.location.hash).toBe('#w/b1')
    })
  })
})

describe('handleBlockLinkClick', () => {
  const ctx = {blockId: 'b-target', workspaceId: 'w-1'}

  const makeEvent = (overrides: Partial<MouseEvent> = {}): MouseEvent => {
    const calls = {stopProp: 0, preventDefault: 0}
    const e = {
      shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, button: 0,
      stopPropagation: () => { calls.stopProp += 1 },
      preventDefault: () => { calls.preventDefault += 1 },
      ...overrides,
    } as unknown as MouseEvent
    ;(e as unknown as {calls: typeof calls}).calls = calls
    return e
  }

  const callsOf = (e: MouseEvent) => (e as unknown as {calls: {stopProp: number; preventDefault: number}}).calls

  it('shift-click navigates new-panel with sourcePanelId', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({shiftKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'new-panel', sourcePanelId: 'panel-a'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('plain primary click navigates focused with panelId', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent()
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'focused', panelId: 'panel-a'})
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 1})
  })

  it('plain primary click without panelId still navigates focused (no panelId in input)', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent()
    handleBlockLinkClick(e, navigate, undefined, ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'focused', panelId: undefined})
  })

  it.each([
    ['metaKey', {metaKey: true}],
    ['ctrlKey', {ctrlKey: true}],
    ['altKey', {altKey: true}],
    ['middle-button', {button: 1}],
    ['right-button', {button: 2}],
  ])('falls through to href on %s (no navigate, no preventDefault)', (_name, override) => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent(override as Partial<MouseEvent>)
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).not.toHaveBeenCalled()
    expect(callsOf(e)).toEqual({stopProp: 1, preventDefault: 0})
  })

  it('shift+modifier still routes to new-panel (shift wins)', () => {
    // Documented behaviour: shift takes precedence over cmd/ctrl. Users who
    // shift-cmd-click expect the panel-open intent, not a new browser tab.
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({shiftKey: true, metaKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(navigate).toHaveBeenCalledWith({...ctx, target: 'new-panel', sourcePanelId: 'panel-a'})
  })

  it('always stops propagation, even on fall-through', () => {
    const navigate = vi.fn<(i: NavigateInput) => void>()
    const e = makeEvent({metaKey: true})
    handleBlockLinkClick(e, navigate, 'panel-a', ctx)
    expect(callsOf(e).stopProp).toBe(1)
  })
})
