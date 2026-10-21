// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo'
import { prepareInitialLayout, preparedInitialHash } from './initialLayout'

// App must key its first lookup on the exact hash the boot prepared for, not on
// a re-read of location.hash: the landing step may already have rewritten it.
describe('prepareInitialLayout', () => {
  it('records the hash it resolved for', () => {
    const repo = {instanceId: 4242} as unknown as Repo
    window.location.hash = '#prepared-here'
    expect(preparedInitialHash(repo)).toBeUndefined()
    void prepareInitialLayout(repo, false).catch(() => {})
    expect(preparedInitialHash(repo)).toBe('#prepared-here')
  })
})
