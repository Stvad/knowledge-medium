// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest'
import {keepFocusAnItemMoved} from '../DefaultBlockRenderer'

const closeEventOn = (menu: HTMLElement) => {
  const event = new Event('focusScope.autoFocusOnUnmount', {cancelable: true})
  menu.addEventListener(event.type, keepFocusAnItemMoved, {once: true})
  menu.dispatchEvent(event)
  return event
}

describe('the bullet menu on close', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('leaves focus where an item moved it, outside the menu', () => {
    document.body.innerHTML = '<div id="menu"><button>Comment</button></div><textarea id="composer"></textarea>'
    document.getElementById('composer')!.focus()
    expect(closeEventOn(document.getElementById('menu')!).defaultPrevented).toBe(true)
  })

  it('returns focus to the bullet when it is still on a menu item', () => {
    document.body.innerHTML = '<div id="menu"><button id="item">Copy</button></div>'
    document.getElementById('item')!.focus()
    expect(closeEventOn(document.getElementById('menu')!).defaultPrevented).toBe(false)
  })

  it('returns focus to the bullet when nothing holds it', () => {
    document.body.innerHTML = '<div id="menu"></div>'
    expect(closeEventOn(document.getElementById('menu')!).defaultPrevented).toBe(false)
  })
})
