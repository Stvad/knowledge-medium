import {mkdtemp, rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium, type Browser, type Locator, type Page} from 'playwright'
import {createServer, type ViteDevServer} from 'vite'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it} from 'vitest'
import type {seedAuthorStamps, seedMarginFixture} from './marginFixture'

let server: ViteDevServer | undefined
let browser: Browser | undefined
let cacheDir: string | undefined
let origin: string
let fixtureUrl: string
let page: Page
let fixture: Awaited<ReturnType<typeof seedMarginFixture>>
/** Full document loads of `page` after its fixture was ready. Hash routes
 *  don't count; a dev-server dependency re-optimization reload does. */
let reloadsSinceReady = 0

beforeAll(async () => {
  cacheDir = await mkdtemp(resolve('node_modules/.vite-margin-browser-'))
  server = await createServer({
    cacheDir,
    envFile: false,
    logLevel: 'error',
    server: {host: '127.0.0.1', port: 0, watch: null, forwardConsole: false},
  })
  await server.listen()
  const localUrl = server.resolvedUrls?.local[0]
  if (!localUrl) throw new Error('The browser fixture server has no local URL')
  origin = localUrl

  browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    // Apply each native wheel delta in one step for the geometry assertions.
    args: ['--disable-smooth-scrolling'],
  })
  // The cache dir starts empty, so the first boot also optimizes dependencies
  // and transforms the whole app. Pay that here, not inside the first test,
  // with waits sized for it.
  await openFixture(COLD_BOOT_WAIT_MS)
  await page.close()
}, 300_000)

beforeEach(() => openFixture())

/** A cold boot's per-step wait: two to six times a warm boot's on CI. */
const COLD_BOOT_WAIT_MS = 60_000

async function openFixture(waitMs = 10_000) {
  if (!browser) throw new Error('Chromium did not start')
  reloadsSinceReady = 0
  page = await browser.newPage({viewport: {width: 1440, height: 780}})
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  await page.addInitScript(() => {
    localStorage.setItem('ftm.localOnly', 'true')
    localStorage.setItem('ftm.user', JSON.stringify({id: 'margin-fixture', name: 'Fixture Reviewer'}))
    addEventListener('pointermove', event => {
      Object.assign(window, {__marginTestPointer: {x: event.clientX, y: event.clientY}})
    }, true)
  })
  await page.goto(origin, {waitUntil: 'commit', timeout: 15_000})
  try {
    await page.waitForFunction(() => !!window.__omniliner?.repo?.activeWorkspaceId &&
      !!document.querySelector('[data-panel-active="true"]'), null, {timeout: 75_000})
  } catch (cause) {
    const text = await page.locator('body').innerText()
    throw new Error(`Local app did not open its panel. ${text}\n${pageErrors.join('\n')}`, {cause})
  }
  fixtureUrl = new URL('/src/plugins/annotations/test/marginFixture.ts', origin).href
  fixture = await page.evaluate<Awaited<ReturnType<typeof seedMarginFixture>>>(
    `import(${JSON.stringify(fixtureUrl)}).then(fixture => fixture.seedMarginFixture())`,
  )
  await card(fixture.first).waitFor({timeout: waitMs})
  await margin().and(page.locator('[aria-busy="false"]')).waitFor({timeout: waitMs})
  page.on('load', () => { reloadsSinceReady++ })
}

afterEach(async () => {
  const reloads = reloadsSinceReady
  await page?.close()
  if (reloads > 0) throw new Error(`The page reloaded ${reloads} time(s) during the test, so its geometry is not the fixture's`)
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cacheDir) await rm(cacheDir, {recursive: true, force: true})
})

const margin = () => page.getByRole('complementary', {name: 'Comments margin'})
const outline = () => page.locator('[data-panel-active="true"] [data-panel-scrollport]')
const card = (thread: {threadId: string}) => margin().locator(`[data-margin-card="${thread.threadId}"]`)
const row = (thread: {targetId: string}) => outline().locator(`[data-block-shell][data-block-id="${thread.targetId}"]`)
const scrollTop = () => outline().evaluate(port => port.scrollTop)
const box = async (locator: Locator) => {
  const bounds = await locator.boundingBox({timeout: 5_000})
  if (!bounds) throw new Error('The element has no bounding box')
  return bounds
}

const renderFrames = () => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/** Returns once the card sits `fromTop` below the port's top AND the margin
 *  has stopped re-placing it: two consecutive samples agree. */
const positionCard = async (locator: Locator, fromTop: number) => {
  let previous: number | null = null
  await expect.poll(async () => {
    const [port, current] = await Promise.all([box(outline()), box(locator)])
    const delta = current.y - port.y - fromTop
    if (Math.abs(delta) >= 3) {
      await outline().evaluate((element, delta) => { element.scrollTop += delta }, delta)
      previous = null
      return `${Math.round(delta)} px from its place`
    }
    const settled = previous === current.y
    const moved = `still moving (${previous} → ${current.y})`
    previous = current.y
    return settled ? 'settled' : moved
  }, {timeout: 5_000}).toBe('settled')
}

/** Every element that can scroll under the pointer, innermost first, with its
 *  offset: where a wheel went when it did not reach the outline. */
const scrollersUnderPointer = () => page.evaluate(() => {
  const {x, y} = (window as {__marginTestPointer?: {x: number, y: number}}).__marginTestPointer ?? {x: -1, y: -1}
  const scrollers: string[] = []
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(el).overflowY) || el.scrollHeight <= el.clientHeight) continue
    const name = el.getAttributeNames().find(attribute => attribute.startsWith('data-')) ?? el.tagName
    scrollers.push(`${name} at ${el.scrollTop} of ${el.scrollHeight - el.clientHeight}`)
  }
  return `(${x}, ${y}): ${scrollers.join(' < ') || 'none'}`
})

const wheelOutline = async (delta: number) => {
  const before = await scrollTop()
  const scrollersBefore = await scrollersUnderPointer()
  await page.mouse.wheel(0, delta)
  await expect.poll(async () => Math.abs(await scrollTop() - before - delta), {timeout: 3_000})
    .toBeLessThanOrEqual(2)
    .catch(async error => {
      throw new Error(`Wheel ${delta} px moved the outline by ${(await scrollTop()) - before} px. ` +
        `Scrollers under the pointer before ${scrollersBefore}; after ${await scrollersUnderPointer()}`, {cause: error})
    })
}

it('scrolls by each wheel delta over an active card and the blank margin', async () => {
  const first = card(fixture.first)
  const textFrame = outline().locator('[data-panel-text-frame]')
  const outlineRowText = (index: number) => textFrame.getByText(`Outline row ${index} with alpha, beta, and gamma.`, {exact: true})
  // Traverse the lazy rows once so wheel deltas compare measured geometry.
  await outlineRowText(35).waitFor({timeout: 5_000})
  await outline().evaluate(port => { port.scrollTop = (port.scrollHeight - port.clientHeight) / 2 })
  await outlineRowText(55).waitFor({timeout: 5_000})
  await outline().evaluate(port => { port.scrollTop = port.scrollHeight })
  await expect.poll(() => textFrame.getByText(/^Outline row \d+ with alpha, beta, and gamma\.$/).count(), {timeout: 5_000})
    .toBe(fixture.rowCount)
  await card(fixture.last).waitFor({timeout: 5_000})
  // Measure native wheel movement without browser compensation for layout shifts.
  await outline().evaluate(port => { port.style.overflowAnchor = 'none' })
  await positionCard(first, 94)
  const firstPill = row(fixture.first).getByRole('button', {name: '3 open comment threads'})
  const offsetAtSelection = await scrollTop()
  await firstPill.click({timeout: 5_000})
  await expect.poll(() => firstPill.getAttribute('aria-expanded')).toBe('true')
  await renderFrames()
  expect(await first.evaluate(element => element.contains(document.activeElement))).toBe(false)
  expect(await scrollTop()).toBe(offsetAtSelection)
  const start = await box(first)
  const onCard = {x: start.x + start.width / 2, y: start.y + 14}
  await page.mouse.move(onCard.x, onCard.y)
  for (const delta of [18, 18, -12, 18, -10]) {
    expect(await first.evaluate((el, {x, y}) => el.contains(document.elementFromPoint(x, y)), onCard)).toBe(true)
    await wheelOutline(delta)
  }
  const end = await box(first)
  expect(Math.abs(end.y - start.y + 32)).toBeLessThan(2)

  const sparse = card(fixture.sparse)
  await positionCard(sparse, 380)
  const gap = await box(sparse)
  const x = gap.x + gap.width / 2
  const y = gap.y - 120
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-margin-card]'), [x, y] as const))
    .toBe(false)
  await page.mouse.move(x, y)
  for (const delta of [16, -12, 16]) await wheelOutline(delta)
  expect(Math.abs((await box(sparse)).y - gap.y + 20)).toBeLessThan(2)

  for (const control of [
    page.getByRole('separator', {name: 'Resize comments margin'}),
    page.getByRole('button', {name: 'Close comments margin'}),
  ]) {
    const before = await box(control)
    await control.hover({timeout: 5_000})
    await wheelOutline(18)
    expect((await box(control)).y).toBeCloseTo(before.y, 0)
  }
})

it('keeps tall card bodies scrollable and moves the outline at both ends', async () => {
  const tall = card(fixture.tall)
  await row(fixture.tall).getByRole('button', {name: '1 open comment thread', exact: true}).click({timeout: 5_000})
  await tall.getByText('Review paragraph 48.', {exact: false}).waitFor({state: 'attached', timeout: 5_000})
  await positionCard(tall, 50)
  const body = tall.locator('[data-margin-card-body]')
  const bodyOffset = () => body.evaluate(element => element.scrollTop)
  const remainingInBody = () => body.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  expect(await remainingInBody()).toBeGreaterThan(200)

  const bounds = await box(body)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100)
  const before = await scrollTop()
  const beforeBody = await bodyOffset()
  await page.mouse.wheel(0, 36)
  await expect.poll(async () => (await bodyOffset()) - beforeBody, {timeout: 3_000}).toBe(36)
  expect(await scrollTop()).toBe(before)

  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  await wheelOutline(24)
  expect(await remainingInBody()).toBeLessThanOrEqual(1)

  await body.evaluate(element => { element.scrollTop = 0 })
  await wheelOutline(-24)
  expect(await bodyOffset()).toBe(0)
})

it('keeps a partially visible card under its click', async () => {
  const displaced = card(fixture.displaced)
  const port = await box(outline())
  const {height} = await box(displaced)
  await positionCard(displaced, -height / 2)
  const clipped = await box(displaced)
  expect(clipped.y).toBeLessThan(port.y)
  expect(clipped.y + clipped.height).toBeGreaterThan(port.y + 20)
  const offset = await scrollTop()
  const text = await box(displaced.getByText('Second card in a dense group.', {exact: true}))
  const textMiddle = text.y + text.height / 2
  expect(textMiddle).toBeGreaterThan(port.y)
  await page.mouse.click(text.x + 6, textMiddle)
  await displaced.getByRole('button', {name: 'Clear comment selection'}).waitFor({timeout: 5_000})
  await renderFrames()
  expect(await scrollTop()).toBe(offset)
  expect((await box(displaced)).y).toBeCloseTo(clipped.y, 0)
})

it('reveals and focuses a displaced card with Enter on its source', async () => {
  const reveal = card(fixture.reveal)
  const source = row(fixture.reveal).getByRole('button', {name: '1 open comment thread', exact: true})
  await source.scrollIntoViewIfNeeded({timeout: 5_000})
  const port = await box(outline())
  expect((await box(reveal)).y).toBeGreaterThan(port.y + port.height)
  await source.focus({timeout: 5_000})
  await page.keyboard.press('Enter')
  await expect.poll(async () => {
    const [port, revealed] = await Promise.all([box(outline()), box(reveal)])
    return revealed.y >= port.y && revealed.y + revealed.height <= port.y + port.height
  }, {timeout: 5_000}).toBe(true)
  expect(await reveal.evaluate(element => element === document.activeElement)).toBe(true)

  const offset = await scrollTop()
  await page.keyboard.press('Tab')
  const focusedControl = await box(reveal.locator(':focus'))
  expect(focusedControl.y).toBeGreaterThanOrEqual(port.y)
  expect(focusedControl.y + focusedControl.height).toBeLessThanOrEqual(port.y + port.height)
  expect(await scrollTop()).toBeCloseTo(offset, 0)

  await page.mouse.move(port.x + 20, port.y + port.height / 2)
  await wheelOutline(48)
  await wheelOutline(-48)
  expect(await scrollTop()).toBeCloseTo(offset, 0)
})

it('keeps an open thread usable while preparing a closed sibling with nested replies', async () => {
  const open = card(fixture.first)
  const closed = card(fixture.closed)
  await open.getByText('First card in a dense group.', {exact: true}).waitFor({timeout: 5_000})
  expect(await closed.count()).toBe(0)
  await page.evaluate(`import(${JSON.stringify(fixtureUrl)}).then(fixture => fixture.holdChildList(${JSON.stringify(fixture.closed.reply)}))`)

  await page.getByRole('button', {name: 'Show closed', exact: true}).click({timeout: 5_000})
  await page.getByRole('button', {name: 'Hide closed', exact: true}).waitFor({timeout: 5_000})
  const pending = () => page.evaluate(({threadId, reply}) => ({
    requested: window.marginFixtureChildList.requested,
    mounted: document.querySelector(`[data-margin-card="${threadId}"]`) !== null,
    childList: window.__omniliner?.repo?.query.childIds({id: reply, hydrate: true, propertyChildren: 'none'}).status(),
  }), fixture.closed)
  await expect.poll(pending, {timeout: 5_000}).toMatchObject({requested: true, mounted: false})

  await row(fixture.first).getByRole('button', {name: '3 open comment threads'}).click({timeout: 5_000})
  await open.getByRole('button', {name: 'Clear comment selection'}).waitFor({timeout: 5_000})
  expect(await closed.count()).toBe(0)

  await page.evaluate(threadId => {
    const gate = window.marginFixtureChildList
    const observer = new MutationObserver(() => {
      const card = document.querySelector<HTMLElement>(`[data-margin-card="${threadId}"]`)
      if (!card?.style.transform || card.style.opacity === '0' || card.hidden) return
      gate.firstPlacedText = card.innerText
      observer.disconnect()
    })
    observer.observe(document.body, {childList: true, attributes: true, subtree: true, attributeFilter: ['style', 'hidden']})
    gate.release()
  }, fixture.closed.threadId)
  await expect.poll(() => page.evaluate(() => window.marginFixtureChildList.firstPlacedText), {timeout: 5_000})
    .toContain(fixture.closed.deepReplyText)
  await closed.getByRole('button', {name: 'Reopen', exact: true}).waitFor({timeout: 5_000})
  expect(await open.getByRole('button', {name: 'Clear comment selection'}).count()).toBe(1)
})

it('can wheel past the final card and back', async () => {
  const port = await box(outline())
  const limits = () => outline().evaluate(element => ({
    offset: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
  }))
  await page.mouse.move(port.x + 20, port.y + port.height / 2)
  for (let step = 0; step < 20; step++) {
    const {offset, maximum} = await limits()
    if (maximum - offset <= 1) break
    await page.mouse.wheel(0, 216)
    await expect.poll(scrollTop, {timeout: 3_000}).toBeGreaterThan(offset)
  }
  const last = card(fixture.last)
  const [after, final] = await Promise.all([box(outline()), box(last)])
  expect(final.y).toBeGreaterThanOrEqual(after.y)
  expect(final.y + final.height).toBeLessThanOrEqual(after.y + after.height)
  const bottom = await limits()
  expect(bottom.maximum - bottom.offset).toBeLessThanOrEqual(1)
  await page.mouse.move(final.x + 8, final.y + final.height / 2)
  await page.mouse.wheel(0, 140)
  await renderFrames()
  expect(await limits()).toEqual(bottom)
  await wheelOutline(-24)
})

// The Chromium run took 83s under concurrent load including the cold app boot.
it('shows author stamps and a self rule in a discussion with mixed authors', async () => {
  const {peerId, agentId, selfId} = await page.evaluate<Awaited<ReturnType<typeof seedAuthorStamps>>>(
    `import(${JSON.stringify(fixtureUrl)}).then(fixture => fixture.seedAuthorStamps(${JSON.stringify(fixture.first.commentId)}))`,
  )
  await row(fixture.first).getByRole('button', {name: '3 open comment threads'}).click({timeout: 5_000})
  const discussion = card(fixture.first)
  await discussion.getByText('A follow-up from automation.', {exact: true}).waitFor({timeout: 5_000})
  const authored = (text: string) => discussion.locator('[data-comment-author]').filter({
    has: page.getByText(text, {exact: true}),
  })
  const self = authored('First card in a dense group.')
  const peer = authored('Feedback from a peer.')
  const agent = authored('A follow-up from automation.')
  const stamp = (entry: Locator) => entry.locator('[data-author-stamp]')
  const visibleStamp = (entry: Locator) => stamp(entry).filter({visible: true})

  for (const [entry, name, profileId, ownership] of [
    [self, 'You', selfId, 'self'],
    [peer, 'Peer Reviewer', peerId, 'other'],
    [agent, 'Review Bot', agentId, 'other'],
  ] as const) {
    const link = entry.getByRole('link', {name, exact: true})
    await link.waitFor({timeout: 5_000})
    expect(await link.getAttribute('href')).toContain(profileId)
    expect(await entry.getAttribute('data-comment-author')).toBe(ownership)
  }
  expect(await visibleStamp(self).count()).toBe(0)
  expect(await visibleStamp(peer).textContent()).toBe('PR')
  expect(await visibleStamp(agent).textContent()).toBe('RB')
  expect(await self.locator('[data-comment-author]').count()).toBe(0)
  expect(await peer.locator('[data-comment-author]').count()).toBe(0)

  const corner = (entry: Locator) => visibleStamp(entry).evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius))
  expect(await corner(peer)).toBeGreaterThan(await corner(agent))

  await peer.getByRole('link', {name: 'Peer Reviewer', exact: true}).hover({timeout: 5_000})
  expect(await visibleStamp(peer).evaluate(element => {
    for (let ancestor: Element | null = element; ancestor && !ancestor.hasAttribute('data-comment-author'); ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).textDecorationLine.includes('underline')) return true
    }
    return false
  })).toBe(false)

  const readRule = (entry: Locator) => entry.evaluate(element => {
    const owner = element.closest('[data-comment-turn]') ?? element
    const style = getComputedStyle(owner)
    const primary = document.createElement('span')
    primary.style.color = 'hsl(var(--primary))'
    owner.appendChild(primary)
    const primaryColor = getComputedStyle(primary).color
    primary.remove()
    return {
      width: style.borderInlineStartWidth,
      color: style.borderInlineStartColor,
      primaryColor,
      actions: [...owner.querySelectorAll('button')].map(button => button.textContent?.trim()),
    }
  })
  const applyTheme = (dark: boolean) => page.evaluate(
    `import(${JSON.stringify(fixtureUrl)}).then(fixture => fixture.applyFixtureTheme(${dark}))`,
  )
  await applyTheme(false)
  const light = await readRule(self)
  expect(light).toMatchObject({width: '3px', color: light.primaryColor, actions: ['Reply', 'Delete', 'Own thread']})
  await applyTheme(true)
  const dark = await readRule(self)
  expect(dark.color).not.toBe(light.color)
  expect(dark).toMatchObject({width: '3px', color: dark.primaryColor})
  expect((await readRule(peer)).width).toBe('0px')
  expect((await readRule(agent)).width).toBe('0px')

  const setPicture = (present: boolean) => page.evaluate(
    `import(${JSON.stringify(fixtureUrl)}).then(fixture => fixture.setFixtureAuthorPicture(${JSON.stringify(selfId)}, ${present}))`,
  )
  await setPicture(true)
  const photo = visibleStamp(self).locator('img')
  await photo.waitFor({timeout: 5_000})
  await expect.poll(() => photo.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth), {timeout: 5_000}).toBe(8)
  await setPicture(false)
  await expect.poll(() => visibleStamp(self).count(), {timeout: 5_000}).toBe(0)
  expect(await self.getByRole('link', {name: 'You', exact: true}).isVisible()).toBe(true)
}, 90_000)
