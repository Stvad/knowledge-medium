// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { BlockLoadingPlaceholder } from '../BlockLoadingPlaceholder.tsx'
import { ownsGestureTarget } from '@/extensions/blockInteraction'

afterEach(cleanup)

// A container that mounts real rows (a review backlog, a recents list) shows
// placeholders for the ones below the fold. Those stand in for a row's space,
// so a pointer landing on one is aimed at that row — the container must not
// claim it, exactly as it must not claim a mounted row's.
describe('a deferred row placeholder', () => {
  it('is a block boundary, so the surface around it cannot claim its gestures', () => {
    const container = document.createElement('div')
    container.className = 'block-content'
    document.body.appendChild(container)
    render(<BlockLoadingPlaceholder />, {container})

    const inside = container.querySelector('.bullet-link')
    expect(inside).not.toBeNull()
    expect(ownsGestureTarget(container, inside)).toBe(false)
  })

  it('leaves the surface owning its own content', () => {
    // Fence: the container still owns everything that is not a placeholder, so
    // the assertion above is about the boundary rather than about `closest`
    // finding nothing.
    const container = document.createElement('div')
    container.className = 'block-content'
    const own = document.createElement('span')
    container.appendChild(own)
    document.body.appendChild(container)

    expect(ownsGestureTarget(container, own)).toBe(true)
  })
})
