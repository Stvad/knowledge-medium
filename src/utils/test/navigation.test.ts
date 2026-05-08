import { describe, it, expect, beforeEach } from 'vitest'
import { navigate } from '@/utils/navigation'
import type { Repo } from '@/data/repo'

const fakeRepo = (workspaceId: string | null = null): Repo =>
  ({activeWorkspaceId: workspaceId} as unknown as Repo)

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
})
