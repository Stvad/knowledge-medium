// @vitest-environment happy-dom
import {render} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {FRAME_SANDBOX} from '../frameDocument.ts'
import {HtmlFrame} from '../HtmlFrame.tsx'

describe('HtmlFrame', () => {
  // Defence in depth: the browser suite passes without it, on the inner frame's.
  it('sandboxes the outer frame with exactly the agreed flags', () => {
    const {container} = render(<HtmlFrame source="<p>hello</p>" scripts="run"/>)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
    expect(FRAME_SANDBOX).toBe('allow-scripts')
  })
})
