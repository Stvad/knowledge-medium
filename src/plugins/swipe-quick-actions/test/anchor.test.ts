import { afterEach, describe, expect, it } from 'vitest'
import {
  findSwipeActionAnchorElement,
  findSwipeActionBlockElement,
} from '../anchor.ts'

describe('swipe action anchor lookup', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('anchors to the block content instead of the full block shell', () => {
    document.body.innerHTML = `
      <div id="panel">
        <a class="blockref" data-block-id="target">target ref</a>
        <div class="tm-block" data-block-id="target">
          <div class="block-controls"></div>
          <div class="block-body">
            <div>
              <div class="block-content" data-anchor="own-content">Target content</div>
              <div class="block-properties">Open properties</div>
            </div>
            <div class="children">
              <div class="tm-block" data-block-id="child">
                <div class="block-content" data-anchor="child-content">Child content</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `

    const panel = document.getElementById('panel')!

    expect(findSwipeActionBlockElement(panel, 'target')?.className).toBe('tm-block')
    expect(findSwipeActionAnchorElement(panel, 'target')?.getAttribute('data-anchor'))
      .toBe('own-content')
  })

  it('falls back to the block shell when a custom layout has no content marker', () => {
    document.body.innerHTML = `
      <div id="panel">
        <section data-block-id="custom" data-anchor="custom-shell">Custom layout</section>
      </div>
    `

    const panel = document.getElementById('panel')!

    expect(findSwipeActionAnchorElement(panel, 'custom')?.getAttribute('data-anchor'))
      .toBe('custom-shell')
  })

  it('narrows duplicate block anchors by render scope', () => {
    document.body.innerHTML = `
      <div id="panel">
        <div class="tm-block" data-block-id="target" data-render-scope-id="outline:root">
          <div class="block-content" data-anchor="outline-content">Outline target</div>
        </div>
        <div class="tm-block" data-block-id="target" data-render-scope-id="embed:source:target:0">
          <div class="block-content" data-anchor="embed-content">Embedded target</div>
        </div>
      </div>
    `

    const panel = document.getElementById('panel')!

    expect(findSwipeActionAnchorElement(panel, 'target', 'embed:source:target:0')?.getAttribute('data-anchor'))
      .toBe('embed-content')
  })
})
