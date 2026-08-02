// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPropertyRows } from '@/utils/propertyNavigation.js'

const makeRow = (blockId: string): HTMLElement => {
  const row = document.createElement('div')
  row.setAttribute('data-property-row', 'true')
  row.dataset.blockId = blockId
  return row
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('getPropertyRows visibility', () => {
  it('includes a row that is genuinely visible', () => {
    const row = makeRow('b1')
    document.body.appendChild(row)

    expect(getPropertyRows('b1')).toEqual([row])
  })

  it('excludes a row whose OWN display is none', () => {
    const row = makeRow('b1')
    row.style.display = 'none'
    document.body.appendChild(row)

    expect(getPropertyRows('b1')).toEqual([])
  })

  // The regression this pins: a property row inside a warm-but-hidden
  // layout session (a keep-alive host's <Activity mode="hidden"> sets
  // display:none on an ANCESTOR wrapper, not the row itself) used to read
  // as "visible" — the old check only ever inspected the row's own computed
  // style. checkVisibility() walks ancestors, so this now correctly reports
  // invisible.
  it('excludes a row hidden by an ANCESTOR display:none', () => {
    const hiddenWrapper = document.createElement('div')
    hiddenWrapper.style.display = 'none'
    const row = makeRow('b1')
    hiddenWrapper.appendChild(row)
    document.body.appendChild(hiddenWrapper)

    expect(getPropertyRows('b1')).toEqual([])
  })

  it('excludes a row hidden by an ANCESTOR visibility:hidden', () => {
    const hiddenWrapper = document.createElement('div')
    hiddenWrapper.style.visibility = 'hidden'
    const row = makeRow('b1')
    hiddenWrapper.appendChild(row)
    document.body.appendChild(hiddenWrapper)

    expect(getPropertyRows('b1')).toEqual([])
  })

  // Environments WITHOUT Element.checkVisibility (older WebViews) take the
  // manual fallback, which must uphold the same ancestor semantics — a
  // hidden keep-alive session's rows must not be focusable there either.
  describe('without checkVisibility (fallback path)', () => {
    const proto = window.Element.prototype as {checkVisibility?: unknown}
    let saved: unknown
    beforeEach(() => {
      saved = proto.checkVisibility
      proto.checkVisibility = undefined
    })
    afterEach(() => {
      proto.checkVisibility = saved
    })

    it('includes a visible row', () => {
      const row = makeRow('b1')
      document.body.appendChild(row)

      expect(getPropertyRows('b1')).toEqual([row])
    })

    it('excludes a row hidden by an ANCESTOR display:none', () => {
      const hiddenWrapper = document.createElement('div')
      hiddenWrapper.style.display = 'none'
      const row = makeRow('b1')
      hiddenWrapper.appendChild(row)
      document.body.appendChild(hiddenWrapper)

      expect(getPropertyRows('b1')).toEqual([])
    })

    it('excludes a row hidden by an ANCESTOR visibility:hidden (inherited)', () => {
      const hiddenWrapper = document.createElement('div')
      hiddenWrapper.style.visibility = 'hidden'
      const row = makeRow('b1')
      hiddenWrapper.appendChild(row)
      document.body.appendChild(hiddenWrapper)

      expect(getPropertyRows('b1')).toEqual([])
    })

    it('includes a row that overrides an ancestor visibility:hidden with visible', () => {
      const hiddenWrapper = document.createElement('div')
      hiddenWrapper.style.visibility = 'hidden'
      const row = makeRow('b1')
      row.style.visibility = 'visible'
      hiddenWrapper.appendChild(row)
      document.body.appendChild(hiddenWrapper)

      expect(getPropertyRows('b1')).toEqual([row])
    })
  })
})
