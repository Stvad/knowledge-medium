/**
 * What a document in an `html-document` frame can and cannot reach, measured in
 * real browsers against the real `HtmlFrame`.
 *
 * Every probe also runs in an unsandboxed CONTROL frame and must succeed there.
 * A probe that cannot work anywhere would "pass" under the sandbox and prove
 * nothing, so the control is half of each assertion.
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Browser} from 'playwright'
import exampleSource from '../example.html?raw'
import {HEIGHT_MESSAGE_TYPE, MAX_FRAME_HEIGHT} from '../frameDocument.ts'
import {
  launchEngine,
  openHost,
  selectedEngines,
  startServers,
  type BoundaryServers,
  type Engine,
  type HostPage,
} from './boundaryHarness.ts'

type Shape = 'sandboxed' | 'control'

/** A navigation or request the document has already started, given this long,
 *  has either landed or was refused. The control frames land inside it. */
const SETTLE_MS = 500

/** Probes an engine's control frame cannot run at all, so they prove nothing
 *  there. Each is a browser feature missing or inert in that engine's build. */
const CONTROL_CANNOT: Record<Engine, readonly string[]> = {
  chromium: [],
  webkit: [],
  firefox: [],
}

/** `history.back()` in a frame moves the top window's history on these engines.
 *  It cannot choose a new URL, but it is a real gap, and the threat model says so. */
const HISTORY_ESCAPES_THE_SANDBOX: Record<Engine, boolean> = {
  chromium: false,
  webkit: true,
  firefox: false,
}

/** STUN packets leave for a host the document names, on these engines. */
const WEBRTC_REACHES_THE_NETWORK: Record<Engine, boolean> = {
  chromium: true,
  webkit: true,
  firefox: true,
}

let servers: BoundaryServers
beforeAll(async () => {
  servers = await startServers()
})
afterAll(() => servers.close())

const mount = (host: HostPage, shape: Shape, source: string) =>
  host.page.evaluate(([mountShape, mountSource]) => {
    if (mountShape === 'sandboxed') window.mountSandboxed(mountSource)
    else window.mountControl(mountSource)
  }, [shape, source] as const)

const script = (body: string) => `<script>${body}</script>`
const ARMED = `top.postMessage('armed', '*');`

const untilReported = (host: HostPage, report: unknown) =>
  vi.waitFor(async () => expect(await host.reports()).toContainEqual(report), {timeout: 10_000, interval: 25})

const settle = (host: HostPage) => host.page.waitForTimeout(SETTLE_MS)

const clickFrame = async (host: HostPage) => {
  const box = await host.page.locator('#mount iframe').boundingBox()
  if (!box) throw new Error('frame has no box')
  await host.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** The frame the document itself runs in: the app's frame's only child. */
const documentFrame = (host: HostPage) => {
  const frame = host.page.frames().find(candidate => candidate.parentFrame()?.parentFrame() === host.page.mainFrame())
  if (!frame) throw new Error('no document frame')
  return frame
}

const frameHeight = (host: HostPage) =>
  host.page.locator('#mount iframe').evaluate(frame => frame.getBoundingClientRect().height)

/** Two frames of the page's rendering: heights apply on the next one. */
const nextRender = (host: HostPage) =>
  host.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))

describe.each(selectedEngines())('%s', engine => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchEngine(engine)
  })
  afterAll(() => browser.close())

  const provesNothingHere = (probe: string) => CONTROL_CANNOT[engine].includes(probe)

  describe('reading what the app holds', () => {
    const READS: Record<string, string> = {
      'the embedding document': `parent.document && 'KM_SECRET_embedder'`,
      'the top document': `top.document.getElementById('secret').textContent`,
      'a global on the top window': `top.kmSecret`,
      'the frame element': `window.frameElement && window.frameElement.ownerDocument.getElementById('secret').textContent`,
      'cookies': `document.cookie`,
      'localStorage': `localStorage.getItem('km_secret')`,
      'sessionStorage': `sessionStorage.getItem('km_secret')`,
      'IndexedDB': `new Promise((done, fail) => {
        const open = indexedDB.open('km-secret', 1)
        open.onerror = () => fail(open.error)
        open.onsuccess = () => {
          const get = open.result.transaction('s').objectStore('s').get('k')
          get.onsuccess = () => done(get.result)
          get.onerror = () => fail(get.error)
        }
      })`,
      'the origin private file system': `navigator.storage.getDirectory()
        .then(root => root.getFileHandle('km-secret'))
        .then(handle => handle.getFile())
        .then(file => file.text())`,
      'Cache Storage': `caches.open('km-secret').then(cache => cache.match('/km-secret')).then(hit => hit.text())`,
      'Web Locks': `navigator.locks.query().then(() => 'KM_SECRET_locks')`,
      'service workers': `navigator.serviceWorker.getRegistrations().then(() => 'KM_SECRET_serviceWorker')`,
    }

    const readDocument = script(`(async () => {
      const probes = {${Object.entries(READS).map(([name, expr]) => `${JSON.stringify(name)}: () => ${expr}`).join(',\n')}}
      for (const [name, probe] of Object.entries(probes)) {
        let value
        try { value = String(await probe()) } catch (error) { value = 'THREW ' + error.name }
        top.postMessage({read: name, value}, '*')
      }
      new BroadcastChannel('km-secret').postMessage('KM_SECRET_broadcast')
      top.postMessage({readsDone: true}, '*')
    })()`)

    const resultsIn = async (shape: Shape) => {
      const host = await openHost(browser, servers.hostUrl)
      await mount(host, shape, readDocument)
      await untilReported(host, {readsDone: true})
      await settle(host)
      const reports = await host.reports() as {read?: string; value?: string}[]
      const channel = await host.page.evaluate(() => window.channelReports)
      await host.close()
      return {
        values: new Map(reports.filter(report => report.read).map(report => [report.read, report.value])),
        channel,
      }
    }

    let control: Awaited<ReturnType<typeof resultsIn>>
    let sandboxed: Awaited<ReturnType<typeof resultsIn>>
    beforeAll(async () => {
      control = await resultsIn('control')
      sandboxed = await resultsIn('sandboxed')
    })

    it.each(Object.keys(READS))('cannot read %s', probe => {
      if (!provesNothingHere(probe)) expect(control.values.get(probe)).toMatch(/KM_SECRET/)
      expect(sandboxed.values.has(probe)).toBe(true)
      expect(sandboxed.values.get(probe)).not.toMatch(/KM_SECRET/)
    })

    it('cannot reach the app over a BroadcastChannel', () => {
      expect(control.channel).toEqual(['KM_SECRET_broadcast'])
      expect(sandboxed.channel).toEqual([])
    })
  })

  describe('making requests', () => {
    const hit = (name: string) => `${servers.decoyUrl}/hit/${name}`
    const swallow = `.catch(() => {})`

    const requests = (): Record<string, string> => ({
      'fetch': script(`fetch('${hit('fetch')}')${swallow}`),
      'XMLHttpRequest': script(`const xhr = new XMLHttpRequest(); xhr.open('GET', '${hit('XMLHttpRequest')}'); xhr.send()`),
      'sendBeacon': script(`try { navigator.sendBeacon('${hit('sendBeacon')}', 'x') } catch {}`),
      'WebSocket': script(`try { new WebSocket('${hit('WebSocket').replace('http', 'ws')}') } catch {}`),
      'EventSource': script(`try { new EventSource('${hit('EventSource')}') } catch {}`),
      'an image': `<img src="${hit('an image')}">`,
      'a script': `<script src="${hit('a script')}.js"></script>`,
      'a stylesheet': `<link rel="stylesheet" href="${hit('a stylesheet')}.css">`,
      'a CSS background': `<div style="width:9px;height:9px;background:url('${hit('a CSS background')}')"></div>`,
      'a web font': `<style>@font-face{font-family:probe;src:url('${hit('a web font')}')}</style><p style="font-family:probe">text</p>`,
      'a video': `<video src="${hit('a video')}" preload="auto"></video>`,
      'an audio element': `<audio src="${hit('an audio element')}" preload="auto"></audio>`,
      'an object': `<object data="${hit('an object')}"></object>`,
      'an embed': `<embed src="${hit('an embed')}">`,
      'a child frame': `<iframe src="${hit('a child frame')}"></iframe>`,
      'a data: child frame': `<iframe src="data:text/html,<script>new Image().src='${hit('a data: child frame')}'</script>"></iframe>`,
      'a srcdoc child frame': `<iframe srcdoc="<script>new Image().src='${hit('a srcdoc child frame')}'</script>"></iframe>`,
      'the realm of a blank child frame': script(`const frame = document.createElement('iframe'); document.documentElement.append(frame); new frame.contentWindow.Image().src = '${hit('the realm of a blank child frame')}'`),
      'a worker': script(`try { new Worker(URL.createObjectURL(new Blob(["fetch('${hit('a worker')}')"], {type: 'text/javascript'}))) } catch {}`),
      'a dynamic import': script(`import('${hit('a dynamic import')}.js')${swallow}`),
      'rel=preload': `<link rel="preload" as="image" href="${hit('rel=preload')}">`,
      'rel=modulepreload': `<link rel="modulepreload" href="${hit('rel=modulepreload')}.js">`,
    })

    const hitsFor = async (shape: Shape) => {
      servers.reset()
      const host = await openHost(browser, servers.hostUrl)
      await mount(host, shape, Object.values(requests()).join('\n') + script(ARMED))
      await untilReported(host, 'armed')
      await settle(host)
      await host.close()
      return servers.decoyHits().map(path => decodeURIComponent(path).replace('/hit/', '').replace(/\.(js|css)$/, ''))
    }

    let control: string[]
    let sandboxed: string[]
    beforeAll(async () => {
      control = await hitsFor('control')
      sandboxed = await hitsFor('sandboxed')
    })

    it('reached the decoy from the control frame through every probe', () => {
      const missing = Object.keys(requests()).filter(probe => !control.includes(probe) && !provesNothingHere(probe))
      expect(missing).toEqual([])
    })

    it('reached nothing from the sandbox', () => {
      expect(sandboxed).toEqual([])
    })
  })

  describe('navigating', () => {
    let host: HostPage
    beforeEach(async () => {
      servers.reset()
      host = await openHost(browser, servers.hostUrl)
    })
    afterEach(() => host.close())

    const url = (name: string) => `${servers.decoyUrl}/hit/${name}`
    const COVER = 'display:block;height:120px;background:#eee'

    /** Mounts `source`, clicks it if asked, and gives whatever that started time
     *  to land. A control frame that moves the top window takes the reports with
     *  it, so its effect is what its caller waits on, not the fence. */
    const attempt = async (shape: Shape, source: string, {click = false} = {}) => {
      await mount(host, shape, source + script(ARMED))
      if (shape === 'control' && !click) return
      await untilReported(host, 'armed')
      if (click) await clickFrame(host)
      await settle(host)
    }

    const decoyWasAsked = () => servers.decoyHits().length > 0

    describe('its own frame somewhere else', () => {
      const SELF_NAVIGATIONS: readonly [string, (name: string) => string, boolean][] = [
        ['location.href', name => script(`setTimeout(() => { location.href = '${url(name)}' })`), false],
        ['location.replace', name => script(`setTimeout(() => location.replace('${url(name)}'))`), false],
        ['a meta refresh', name => `<meta http-equiv="refresh" content="0;url=${url(name)}">`, false],
        ['a data: document', name => script(`setTimeout(() => { location.href = "data:text/html,<script>new Image().src='${url(name)}'<\\/script>" })`), false],
        ['a blob: document', name => script(`setTimeout(() => { location.href = URL.createObjectURL(new Blob(["<script>new Image().src='${url(name)}'<\\/script>"], {type: 'text/html'})) })`), false],
        ['a clicked link', name => `<a href="${url(name)}" style="${COVER}">go</a>`, true],
      ]

      it.each(SELF_NAVIGATIONS)('cannot load a remote document through %s', async (_name, source, click) => {
        await attempt('control', source('self'), {click})
        await vi.waitFor(() => expect(decoyWasAsked()).toBe(true), {timeout: 5_000})

        servers.reset()
        const sandboxedHost = await openHost(browser, servers.hostUrl)
        const previous = host
        host = sandboxedHost
        await previous.close()
        await attempt('sandboxed', source('self'), {click})
        expect(servers.decoyHits()).toEqual([])
      })
    })

    describe('the top window', () => {
      const TOP_NAVIGATIONS: readonly [string, (name: string) => string, boolean][] = [
        ['top.location', name => script(`setTimeout(() => { try { top.location = '${url(name)}' } catch {} })`), false],
        ['parent.location', name => script(`setTimeout(() => { try { parent.location = '${url(name)}' } catch {} })`), false],
        ['a click running top.location', name => `<button style="${COVER};width:100%" onclick="top.location = '${url(name)}'">go</button>`, true],
        ['a click running parent.location', name => `<button style="${COVER};width:100%" onclick="parent.location = '${url(name)}'">go</button>`, true],
        ['a clicked target=_top link', name => `<a href="${url(name)}" target="_top" style="${COVER}">go</a>`, true],
        ['a clicked target=_parent link', name => `<a href="${url(name)}" target="_parent" style="${COVER}">go</a>`, true],
      ]

      it.each(TOP_NAVIGATIONS)('cannot move it through %s', async (_name, source, click) => {
        const start = host.page.url()
        await attempt('control', source('top'), {click})
        await vi.waitFor(() => expect(host.page.url()).not.toBe(start), {timeout: 5_000})

        servers.reset()
        const sandboxedHost = await openHost(browser, servers.hostUrl)
        const previous = host
        host = sandboxedHost
        await previous.close()
        await attempt('sandboxed', source('top'), {click})
        expect(host.page.url()).toBe(start)
        expect(servers.decoyHits()).toEqual([])
      })

      it('moves it with history.back() only on the engines the threat model names', async () => {
        const historyDocument = script(`setTimeout(() => history.back())`)
        const pushTwoEntries = () => host.page.evaluate(() => {
          history.pushState({}, '', '#a')
          history.pushState({}, '', '#b')
        })
        await pushTwoEntries()
        await attempt('control', historyDocument)
        await vi.waitFor(() => expect(host.page.url()).toMatch(/#a$/), {timeout: 5_000})

        const previous = host
        host = await openHost(browser, servers.hostUrl)
        await previous.close()
        await pushTwoEntries()
        await attempt('sandboxed', historyDocument)
        expect(host.page.url().endsWith('#a')).toBe(HISTORY_ESCAPES_THE_SANDBOX[engine])
      })
    })

    describe('opening or submitting anything', () => {
      const replaceHost = async () => {
        servers.reset()
        const previous = host
        host = await openHost(browser, servers.hostUrl)
        await previous.close()
      }

      it.each<[string, (name: string) => string]>([
        ['a click running window.open', name => `<button style="${COVER};width:100%" onclick="window.open('${url(name)}')">go</button>`],
        ['a clicked target=_blank link', name => `<a href="${url(name)}" target="_blank" style="${COVER}">go</a>`],
      ])('cannot open a popup through %s', async (_name, source) => {
        await attempt('control', source('popup'), {click: true})
        await vi.waitFor(() => expect(host.popups()).toBe(1), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', source('popup'), {click: true})
        expect(host.popups()).toBe(0)
        expect(servers.decoyHits()).toEqual([])
      })

      it('cannot submit a form', async () => {
        const form = `<form action="${url('form')}"><button style="${COVER};width:100%">go</button></form>`
        await attempt('control', form, {click: true})
        await vi.waitFor(() => expect(decoyWasAsked()).toBe(true), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', form, {click: true})
        expect(servers.decoyHits()).toEqual([])
      })

      it('cannot ping a server from a clicked link', async () => {
        const link = `<a href="#x" ping="${url('ping')}" style="${COVER}">go</a>`
        if (!provesNothingHere('ping')) {
          await attempt('control', link, {click: true})
          await vi.waitFor(() => expect(decoyWasAsked()).toBe(true), {timeout: 5_000})
        }
        await replaceHost()
        await attempt('sandboxed', link, {click: true})
        expect(servers.decoyHits()).toEqual([])
      })

      it('cannot start a download', async () => {
        const link = `<a download="x.txt" href="data:text/plain,x" style="${COVER}">go</a>`
        await attempt('control', link, {click: true})
        await vi.waitFor(() => expect(host.downloads()).toBe(1), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', link, {click: true})
        expect(host.downloads()).toBe(0)
      })

      it('cannot open a dialog', async () => {
        const dialog = script(`setTimeout(() => alert('x'))`)
        await attempt('control', dialog)
        await vi.waitFor(() => expect(host.dialogs()).toBe(1), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', dialog)
        expect(host.dialogs()).toBe(0)
      })
    })

    it('keeps source that tries to break out of the attribute inside the inner frame', async () => {
      // In the inner frame the navigation is refused. If this ever reached the
      // outer document, nothing above it would refuse.
      const hostile = `"></iframe></body>${script(`location.href = '${url('escaped')}'`)}<iframe srcdoc="`
      await mount(host, 'sandboxed', script(ARMED) + hostile)
      await untilReported(host, 'armed')
      await settle(host)
      expect(servers.decoyHits()).toEqual([])
    })
  })

  describe('sizing the frame', () => {
    let host: HostPage
    beforeEach(async () => {
      host = await openHost(browser, servers.hostUrl)
    })
    afterEach(() => host.close())

    const NO_MARGIN = '<style>body{margin:0}</style>'
    const blockOf = (px: number) => `${NO_MARGIN}<div style="height:${px}px"></div>`
    const untilHeight = (height: number) =>
      vi.waitFor(async () => expect(await frameHeight(host)).toBe(height), {timeout: 5_000, interval: 25})

    it('follows the document, up and down', async () => {
      await mount(host, 'sandboxed', `${NO_MARGIN}<div id="box" style="height:640px"></div>${script(`
        addEventListener('message', event => { document.getElementById('box').style.height = event.data + 'px' })
      `)}`)
      await untilHeight(640)
      await documentFrame(host).evaluate(() => window.postMessage(200, '*'))
      await untilHeight(200)
    })

    it('measures a document whose body is pinned to the frame', async () => {
      await mount(host, 'sandboxed', `<style>html,body{height:100%}</style>${blockOf(900)}`)
      await untilHeight(900)
    })

    it('never grows past the clamp however tall the document is', async () => {
      await mount(host, 'sandboxed', blockOf(1_000_000))
      await untilHeight(MAX_FRAME_HEIGHT)
    })

    it.each<[string, (message: string) => Promise<unknown>]>([
      ['the top window itself', message => host.page.evaluate(body => window.postMessage(JSON.parse(body), '*'), message)],
      ['a sibling frame', message => host.page.evaluate(body => {
        const sibling = document.createElement('iframe')
        sibling.srcdoc = `<script>top.postMessage(${body}, '*')</script>`
        document.body.append(sibling)
      }, message)],
      ['a frame the document opened inside itself', message => mountNested(message)],
    ])('takes a height only from the document\'s own window, not %s', async (_name, spoof) => {
      const spoofed = JSON.stringify({type: HEIGHT_MESSAGE_TYPE, height: 777})
      await mount(host, 'sandboxed', blockOf(300))
      await untilHeight(300)

      await spoof(spoofed)
      await untilReported(host, {type: HEIGHT_MESSAGE_TYPE, height: 777})
      await nextRender(host)
      expect(await frameHeight(host)).toBe(300)

      // The same message from the window it should come from does move it, so
      // the assertion above is about the source and not about the message.
      await documentFrame(host).evaluate(body => window.parent.parent.postMessage(JSON.parse(body), '*'), spoofed)
      await untilHeight(777)
    })

    const mountNested = (message: string) =>
      documentFrame(host).evaluate(body => {
        const nested = document.createElement('iframe')
        // Out of flow, or the document would legitimately report a new height.
        nested.style.cssText = 'position:absolute;width:0;height:0;border:0'
        nested.srcdoc = `<script>top.postMessage(${body}, '*')</script>`
        document.body.append(nested)
      }, message)
  })

  describe('the theme', () => {
    it('reaches the document as the app\'s own tokens, and follows a theme change', async () => {
      const host = await openHost(browser, servers.hostUrl)
      await host.page.evaluate(() => {
        document.documentElement.style.setProperty('--primary', '1 2% 3%')
      })
      const reader = script(`top.postMessage({primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()}, '*')`)
      await mount(host, 'sandboxed', reader)
      await untilReported(host, {primary: '1 2% 3%'})

      await host.page.evaluate(() => {
        document.documentElement.style.setProperty('--primary', '4 5% 6%')
        document.documentElement.dataset.theme = 'probe'
      })
      await untilReported(host, {primary: '4 5% 6%'})
      await host.close()
    })
  })

  describe('the example document', () => {
    it('runs its script and styles under the policy', async () => {
      const host = await openHost(browser, servers.hostUrl)
      await mount(host, 'sandboxed', exampleSource)
      const document = host.page.frameLocator('#mount iframe').frameLocator('iframe')
      await expect.poll(() => document.locator('#verdict').textContent(), {timeout: 10_000}).toContain('70% hydration')
      expect(await document.locator('#fill').evaluate(fill => fill.getBoundingClientRect().width)).toBeGreaterThan(0)
      await host.close()
    })
  })

  // Not promises: what the threat model says a document can still do. These are
  // pinned where they were measured, so a browser closing one shows up here.
  describe('what a document can still do', () => {
    it('reaches a host of its choosing over WebRTC only where the threat model says', async () => {
      servers.reset()
      const host = await openHost(browser, servers.hostUrl)
      await mount(host, 'sandboxed', script(`
        const peer = new RTCPeerConnection({iceServers: [{urls: 'stun:${servers.stunAddress}'}]})
        peer.createDataChannel('x')
        peer.createOffer().then(offer => peer.setLocalDescription(offer))
        window.keepAlive = peer
        ${ARMED}
      `))
      await untilReported(host, 'armed')
      if (WEBRTC_REACHES_THE_NETWORK[engine]) {
        await vi.waitFor(() => expect(servers.stunPackets()).toBeGreaterThan(0), {timeout: 5_000})
      } else {
        await settle(host)
        expect(servers.stunPackets()).toBe(0)
      }
      await host.close()
    })

    it.runIf(engine === 'chromium')('can overwrite the clipboard after a click inside it', async () => {
      const host = await openHost(browser, servers.hostUrl)
      await mount(host, 'sandboxed', `<textarea id="source">x</textarea><button style="display:block;height:120px;width:100%" onclick="
        document.getElementById('source').select()
        top.postMessage({copied: document.execCommand('copy')}, '*')
      ">go</button>${script(ARMED)}`)
      await untilReported(host, 'armed')
      const box = await host.page.locator('#mount iframe').boundingBox()
      if (!box) throw new Error('frame has no box')
      await host.page.mouse.click(box.x + box.width / 2, box.y + box.height - 30)
      await untilReported(host, {copied: true})
      await host.close()
    })
  })
})
