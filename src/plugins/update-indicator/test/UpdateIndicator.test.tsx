// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'

const mocks = vi.hoisted(() => ({
  inFocus: false,
  previousLoadTime: 100,
  updateInfo: undefined as undefined | {updatedBy: string; updatedAt: number; userUpdatedAt: number},
}))
vi.mock('@/data/globalState', () => ({
  useInFocus: () => mocks.inFocus,
  usePluginPrefsProperty: () => [mocks.previousLoadTime],
  useUserPage: () => ({name: 'Ada'}),
}))
vi.mock('@/hooks/block.js', () => ({useUpdateMetadata: () => mocks.updateInfo}))

import { UpdateIndicator } from '../UpdateIndicator.tsx'

const block = {id: 'block-1', repo: {user: {id: 'me'}}} as unknown as Block
const updatedBy = (user: string) => ({updatedBy: user, updatedAt: 5, userUpdatedAt: 200})

beforeEach(() => {
  mocks.inFocus = false
  mocks.updateInfo = updatedBy('other')
})
afterEach(cleanup)

describe('UpdateIndicator', () => {
  it('renders the dot, with who and when, for an edit by another user since the last load', () => {
    const {container} = render(<UpdateIndicator block={block}/>)
    expect(container.querySelector('span')?.getAttribute('title')).toMatch(/^Updated by Ada on /)
  })

  it('renders nothing for the user\'s own edit', () => {
    mocks.updateInfo = updatedBy('me')
    const {container} = render(<UpdateIndicator block={block}/>)
    expect(container.innerHTML).toBe('')
  })

  it('hides for good once the block has taken focus', () => {
    const view = render(<UpdateIndicator block={block}/>)
    mocks.inFocus = true
    view.rerender(<UpdateIndicator block={block}/>)
    mocks.inFocus = false
    view.rerender(<UpdateIndicator block={block}/>)
    expect(view.container.innerHTML).toBe('')
  })
})
