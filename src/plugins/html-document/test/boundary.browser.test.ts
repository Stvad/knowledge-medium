/**
 * What a document in an `html-document` frame can and cannot reach, measured in
 * real browsers against the real `HtmlFrame`.
 *
 * Every probe also runs in an unsandboxed CONTROL frame and must succeed there.
 * A probe that cannot work anywhere would "pass" under the sandbox and prove
 * nothing, so the control is half of each assertion.
 */

import {createHash} from 'node:crypto'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Browser} from 'playwright'
import exampleSource from '../example.html?raw'
import {HEIGHT_MESSAGE_TYPE, HEIGHT_REPORTER, MAX_FRAME_HEIGHT} from '../frameDocument.ts'
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
const REPORTER_HASH = `sha256-${createHash('sha256').update(HEIGHT_REPORTER).digest('base64')}`

/** Probes an engine's control frame cannot run at all, so they prove nothing
 *  there. Each is a browser feature missing or inert in that engine's build. */
const CONTROL_CANNOT: Record<Engine, readonly string[]> = {
  chromium: [],
  // No origin private file system in a throwaway browser context.
  webkit: ['the origin private file system'],
  // Hyperlink auditing is off by default.
  firefox: ['ping'],
}

/** A document takes keyboard focus from the app with no click, on these builds.
 *  Playwright's, whose focus handling differs from a shipped browser's: `webkit`
 *  here says nothing about Safari on an iPhone. */
const TAKES_THE_KEYBOARD: Record<Engine, boolean> = {
  chromium: true,
  webkit: false,
  firefox: true,
}

/** A parsed `<link rel=prerender>` sends a GET the policy never sees, on these
 *  engines. */
const PRERENDER_REACHES_THE_NETWORK: Record<Engine, boolean> = {
  chromium: true,
  webkit: false,
  firefox: false,
}

/** `history.back()` in a frame moves the top window's history on these engines. It
 *  cannot choose a new URL, but it is a real gap. */
const HISTORY_ESCAPES_THE_SANDBOX: Record<Engine, boolean> = {
  chromium: false,
  webkit: true,
  firefox: true,
}

/** A frame's fragment navigation, after load. Where it doesn't, there is nothing for
 *  Back to return to. */
const FRAGMENT_ADDS_TO_HISTORY: Record<Engine, boolean> = {
  chromium: true,
  webkit: true,
  firefox: false,
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
const decoy = (name: string) => `${servers.decoyUrl}/hit/${name}`
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

const historyLength = (host: HostPage) => host.page.evaluate(() => history.length)

const clearReports = (host: HostPage) => host.page.evaluate(() => {
  window.reports.length = 0
})

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

  const mountRunning = async (host: HostPage, source: string) => {
    await mount(host, 'sandboxed', source + script(ARMED))
    await untilReported(host, 'armed')
  }

  /** No author script runs to fence on here, so the fence is the height report. */
  const mountHeld = async (host: HostPage, source: string) => {
    await host.page.evaluate(held => window.mountSandboxed(held, 'hold'), source)
    await vi.waitFor(async () => {
      const reports = await host.reports() as {type?: string}[]
      expect(reports.some(report => report.type === HEIGHT_MESSAGE_TYPE)).toBe(true)
    }, {timeout: 10_000, interval: 25})
  }

  const KEYBOARD_THIEF = `<input id="field">${script(`
    addEventListener('keydown', event => top.postMessage({stolen: event.key}, '*'), true)
    setInterval(() => {
      window.focus()
      document.getElementById('field').focus()
    }, 30)
  `)}`

  const typeIntoApp = async (mountDocument: (host: HostPage) => Promise<void>) => {
    const host = await openHost(browser, servers.hostUrl)
    await host.page.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'app-input'
      document.body.prepend(input)
      input.focus()
    })
    await mountDocument(host)
    await settle(host)
    await host.page.keyboard.type('abcde', {delay: 60})
    await settle(host)
    const reports = await host.reports() as {stolen?: string}[]
    const result = {
      inApp: await host.page.locator('#app-input').inputValue(),
      stolen: reports.map(report => report.stolen ?? '').join(''),
    }
    await host.close()
    return result
  }

  const stunProbe = () => script(`
    const peer = new RTCPeerConnection({iceServers: [{urls: ${JSON.stringify(servers.stunUrls)}}]})
    peer.createDataChannel('x')
    peer.createOffer().then(offer => peer.setLocalDescription(offer))
    window.keepAlive = peer
  `)

  const stunPacketsFrom = async (mountDocument: (host: HostPage) => Promise<void>) => {
    servers.reset()
    const host = await openHost(browser, servers.hostUrl)
    await mountDocument(host)
    await vi.waitFor(() => expect(servers.stunPackets()).toBeGreaterThan(0), {timeout: 3_000}).catch(() => {})
    await host.close()
    return servers.stunPackets()
  }

  describe('reading what the app holds', () => {
    const READS: Record<string, string> = {
      'the embedding document': `parent.document && 'KM_SECRET_embedder'`,
      'the top document': `top.document.getElementById('secret').textContent`,
      // The app's URL holds the workspace and the open blocks.
      'the app URL through its base URL': `document.baseURI`,
      'the app URL through a relative link': `Object.assign(document.createElement('a'), {href: ''}).href`,
      'the app URL through a removed base': `(document.querySelector('base')?.remove(), document.baseURI)`,
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
    const swallow = `.catch(() => {})`

    const requests = (): Record<string, string> => ({
      'fetch': script(`fetch('${decoy('fetch')}')${swallow}`),
      'XMLHttpRequest': script(`const xhr = new XMLHttpRequest(); xhr.open('GET', '${decoy('XMLHttpRequest')}'); xhr.send()`),
      'sendBeacon': script(`try { navigator.sendBeacon('${decoy('sendBeacon')}', 'x') } catch {}`),
      'WebSocket': script(`try { new WebSocket('${decoy('WebSocket').replace('http', 'ws')}') } catch {}`),
      'EventSource': script(`try { new EventSource('${decoy('EventSource')}') } catch {}`),
      'an image': `<img src="${decoy('an image')}">`,
      'a script': `<script src="${decoy('a script')}.js"></script>`,
      'a stylesheet': `<link rel="stylesheet" href="${decoy('a stylesheet')}.css">`,
      'a CSS background': `<div style="width:9px;height:9px;background:url('${decoy('a CSS background')}')"></div>`,
      'a web font': `<style>@font-face{font-family:probe;src:url('${decoy('a web font')}')}</style><p style="font-family:probe">text</p>`,
      'a video': `<video src="${decoy('a video')}" preload="auto"></video>`,
      'an audio element': `<audio src="${decoy('an audio element')}" preload="auto"></audio>`,
      'an object': `<object data="${decoy('an object')}"></object>`,
      'an embed': `<embed src="${decoy('an embed')}">`,
      'a child frame': `<iframe src="${decoy('a child frame')}"></iframe>`,
      'a data: child frame': `<iframe src="data:text/html,<script>new Image().src='${decoy('a data: child frame')}'</script>"></iframe>`,
      'a srcdoc child frame': `<iframe srcdoc="<script>new Image().src='${decoy('a srcdoc child frame')}'</script>"></iframe>`,
      'a worker': script(`try { new Worker(URL.createObjectURL(new Blob(["fetch('${decoy('a worker')}')"], {type: 'text/javascript'}))) } catch {}`),
      'a dynamic import': script(`import('${decoy('a dynamic import')}.js')${swallow}`),
      'rel=preload': `<link rel="preload" as="image" href="${decoy('rel=preload')}">`,
      'rel=modulepreload': `<link rel="modulepreload" href="${decoy('rel=modulepreload')}.js">`,
      // A hash in the policy would allow each of these, and the reporter's is public.
      'a script naming the reporter': `<script src="${decoy('a script naming the reporter')}.js" integrity="${REPORTER_HASH}"></script>`,
      'a module naming the reporter': `<script type="module" src="${decoy('a module naming the reporter')}.js" integrity="${REPORTER_HASH}"></script>`,
      'a preload naming the reporter': `<link rel="preload" as="script" href="${decoy('a preload naming the reporter')}.js" integrity="${REPORTER_HASH}">`,
      'a modulepreload naming the reporter': `<link rel="modulepreload" href="${decoy('a modulepreload naming the reporter')}.js" integrity="${REPORTER_HASH}">`,
    })

    const hitsFor = async (shape: Shape | 'held') => {
      servers.reset()
      const host = await openHost(browser, servers.hostUrl)
      const probes = Object.values(requests()).join('\n')
      if (shape === 'held') {
        await mountHeld(host, probes)
      } else {
        await mount(host, shape, probes + script(ARMED))
        await untilReported(host, 'armed')
      }
      await settle(host)
      await host.close()
      return servers.decoyHits().map(path => decodeURIComponent(path).replace('/hit/', '').replace(/\.(js|css)$/, ''))
    }

    let control: string[]
    let sandboxed: string[]
    let held: string[]
    beforeAll(async () => {
      control = await hitsFor('control')
      sandboxed = await hitsFor('sandboxed')
      held = await hitsFor('held')
    })

    it('reached the decoy from the control frame through every probe', () => {
      const missing = Object.keys(requests()).filter(probe => !control.includes(probe))
      expect(missing).toEqual([])
    })

    it('reached nothing from a held document', () => {
      expect(held).toEqual([])
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

    /** A page of its own for the sandboxed half, after the control half moved or
     *  scribbled on the last one. */
    const replaceHost = async () => {
      servers.reset()
      const previous = host
      host = await openHost(browser, servers.hostUrl)
      await previous.close()
    }

    describe('its own frame somewhere else', () => {
      const SELF_NAVIGATIONS: readonly [string, () => string, boolean][] = [
        ['location.href', () => script(`setTimeout(() => { location.href = '${decoy('nav')}' })`), false],
        ['location.replace', () => script(`setTimeout(() => location.replace('${decoy('nav')}'))`), false],
        ['a meta refresh', () => `<meta http-equiv="refresh" content="0;url=${decoy('nav')}">`, false],
        ['a data: document', () => script(`setTimeout(() => { location.href = "data:text/html,<script>new Image().src='${decoy('nav')}'<\\/script>" })`), false],
        ['a blob: document', () => script(`setTimeout(() => { location.href = URL.createObjectURL(new Blob(["<script>new Image().src='${decoy('nav')}'<\\/script>"], {type: 'text/html'})) })`), false],
        ['a clicked link', () => `<a href="${decoy('nav')}" style="${COVER}">go</a>`, true],
      ]

      it.each(SELF_NAVIGATIONS)('cannot load a remote document through %s', async (_name, source, click) => {
        await attempt('control', source(), {click})
        await vi.waitFor(() => expect(decoyWasAsked()).toBe(true), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', source(), {click})
        expect(servers.decoyHits()).toEqual([])
      })
    })

    describe('the top window', () => {
      const TOP_NAVIGATIONS: readonly [string, () => string, boolean][] = [
        ['top.location', () => script(`setTimeout(() => { try { top.location = '${decoy('nav')}' } catch {} })`), false],
        ['parent.location', () => script(`setTimeout(() => { try { parent.location = '${decoy('nav')}' } catch {} })`), false],
        ['a click running top.location', () => `<button style="${COVER};width:100%" onclick="top.location = '${decoy('nav')}'">go</button>`, true],
        ['a click running parent.location', () => `<button style="${COVER};width:100%" onclick="parent.location = '${decoy('nav')}'">go</button>`, true],
        ['a clicked target=_top link', () => `<a href="${decoy('nav')}" target="_top" style="${COVER}">go</a>`, true],
        ['a clicked target=_parent link', () => `<a href="${decoy('nav')}" target="_parent" style="${COVER}">go</a>`, true],
      ]

      it.each(TOP_NAVIGATIONS)('cannot move it through %s', async (_name, source, click) => {
        const start = host.page.url()
        await attempt('control', source(), {click})
        await vi.waitFor(() => expect(host.page.url()).not.toBe(start), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', source(), {click})
        expect(host.page.url()).toBe(start)
        expect(servers.decoyHits()).toEqual([])
      })

      it('moves it with history.back() only on the engines named above', async () => {
        const historyDocument = script(`setTimeout(() => history.back())`)
        const pushTwoEntries = () => host.page.evaluate(() => {
          history.pushState({}, '', '#a')
          history.pushState({}, '', '#b')
        })
        await pushTwoEntries()
        await attempt('control', historyDocument)
        await vi.waitFor(() => expect(host.page.url()).toMatch(/#a$/), {timeout: 5_000})

        await replaceHost()
        await pushTwoEntries()
        await attempt('sandboxed', historyDocument)
        expect(host.page.url().endsWith('#a')).toBe(HISTORY_ESCAPES_THE_SANDBOX[engine])
      })
    })

    describe('opening or submitting anything', () => {
      it.each<[string, () => string]>([
        ['a click running window.open', () => `<button style="${COVER};width:100%" onclick="window.open('${decoy('nav')}')">go</button>`],
        ['a clicked target=_blank link', () => `<a href="${decoy('nav')}" target="_blank" style="${COVER}">go</a>`],
      ])('cannot open a popup through %s', async (_name, source) => {
        await attempt('control', source(), {click: true})
        await vi.waitFor(() => expect(host.popups()).toBe(1), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', source(), {click: true})
        expect(host.popups()).toBe(0)
        expect(servers.decoyHits()).toEqual([])
      })

      it('cannot submit a form', async () => {
        const form = `<form action="${decoy('form')}"><button style="${COVER};width:100%">go</button></form>`
        await attempt('control', form, {click: true})
        await vi.waitFor(() => expect(decoyWasAsked()).toBe(true), {timeout: 5_000})

        await replaceHost()
        await attempt('sandboxed', form, {click: true})
        expect(servers.decoyHits()).toEqual([])
      })

      it('cannot ping a server from a clicked link', async () => {
        const link = `<a href="#x" ping="${decoy('ping')}" style="${COVER}">go</a>`
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

    it('follows an in-document anchor without leaving the document', async () => {
      await mount(host, 'sandboxed', `<a href="#end" style="${COVER}">go</a><div style="height:2000px"></div><p id="end">end</p>${script(`
        addEventListener('hashchange', () => top.postMessage({hash: location.hash, stillHere: Boolean(document.getElementById('end'))}, '*'))
        ${ARMED}
      `)}`)
      await untilReported(host, 'armed')
      await host.page.frameLocator('#mount iframe').frameLocator('iframe').locator('a').click()
      await untilReported(host, {hash: '#end', stillHere: true})
    })

    it('keeps source that tries to break out of the attribute inside the inner frame', async () => {
      // In the inner frame the navigation is refused. If this ever reached the
      // outer document, nothing above it would refuse.
      const hostile = `"></iframe></body>${script(`location.href = '${decoy('escaped')}'`)}<iframe srcdoc="`
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

    it('takes other messages in its stride before the document\'s window exists', async () => {
      const errors: string[] = []
      host.page.on('pageerror', error => errors.push(error.message))
      await host.page.evaluate(() => {
        setInterval(() => window.postMessage('from someone else', '*'), 0)
      })
      await mount(host, 'sandboxed', blockOf(300))
      await untilHeight(300)
      expect(errors).toEqual([])
    })

    // Spread over tasks: React already batches a burst inside one task.
    it('applies far fewer heights than a flood of messages sends', async () => {
      await mount(host, 'sandboxed', blockOf(300))
      await untilHeight(300)
      await host.page.evaluate(() => {
        const frame = document.querySelector('#mount iframe') as HTMLElement
        const writes = {count: 0}
        ;(window as unknown as {writes: typeof writes}).writes = writes
        new MutationObserver(records => {
          writes.count += records.length
        }).observe(frame, {attributes: true, attributeFilter: ['style']})
      })
      await documentFrame(host).evaluate(type => {
        let sent = 0
        const send = () => {
          window.parent.parent.postMessage(sent < 600 ? {type, height: 300 + (sent % 2)} : 'flood over', '*')
          sent += 1
          if (sent <= 600) setTimeout(send, 0)
        }
        send()
      }, HEIGHT_MESSAGE_TYPE)
      await untilReported(host, 'flood over')
      await nextRender(host)
      const writes = await host.page.evaluate(() => (window as unknown as {writes: {count: number}}).writes.count)
      expect(writes).toBeLessThan(200)
    })

    it('measures a document whose body is pinned to the frame', async () => {
      await mount(host, 'sandboxed', `<style>html,body{height:100%}</style>${blockOf(900)}`)
      await untilHeight(900)
    })

    it('never grows past the clamp however tall the document is', async () => {
      await mount(host, 'sandboxed', blockOf(1_000_000))
      await untilHeight(MAX_FRAME_HEIGHT)
    })

    const mountNested = (message: string) =>
      documentFrame(host).evaluate(body => {
        const nested = document.createElement('iframe')
        // Out of flow, or the document would legitimately report a new height.
        nested.style.cssText = 'position:absolute;width:0;height:0;border:0'
        nested.srcdoc = `<script>top.postMessage(${body}, '*')</script>`
        document.body.append(nested)
      }, message)

    it.each<[string, (message: string) => Promise<unknown>]>([
      ['the top window itself', message => host.page.evaluate(body => window.postMessage(JSON.parse(body), '*'), message)],
      ['a sibling frame', message => host.page.evaluate(body => {
        const sibling = document.createElement('iframe')
        sibling.srcdoc = `<script>top.postMessage(${body}, '*')</script>`
        document.body.append(sibling)
      }, message)],
      ['a frame the document opened inside itself', mountNested],
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
  })

  describe('the theme', () => {
    it('reaches the document as the app\'s own tokens, and follows a theme change', async () => {
      const host = await openHost(browser, servers.hostUrl)
      await host.page.evaluate(() => {
        document.documentElement.style.setProperty('--primary', '1 2% 3%')
      })
      // After a frame of rendering: a frame being reloaded may have no styles yet
      // when its first script runs.
      const reader = script(`addEventListener('load', () => requestAnimationFrame(() => {
        top.postMessage({primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()}, '*')
      }))`)
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

  describe('with scripts held', () => {
    let host: HostPage
    beforeEach(async () => {
      servers.reset()
      host = await openHost(browser, servers.hostUrl)
    })
    afterEach(() => host.close())

    const ATTEMPTS = {
      'an inline script': script(`top.postMessage({ran: 'an inline script'}, '*')`),
      'an event handler': `<img src="x" onerror="top.postMessage({ran: 'an event handler'}, '*')">`,
      'an SVG onload': `<svg onload="top.postMessage({ran: 'an SVG onload'}, '*')"></svg>`,
      'a child frame': `<iframe srcdoc="<script>top.postMessage({ran: 'a child frame'}, '*')</script>"></iframe>`,
    }
    const ATTEMPTS_DOCUMENT = Object.values(ATTEMPTS).join('')
    const LINK = `<a href="javascript:top.postMessage({ran: 'a javascript: link'}, '*')">go</a>`

    const ranSoFar = async () => (await host.reports() as {ran?: string}[]).flatMap(report => report.ran ?? [])

    it('runs none of the code the same document runs when allowed', async () => {
      await mountRunning(host, ATTEMPTS_DOCUMENT)
      for (const name of Object.keys(ATTEMPTS)) await untilReported(host, {ran: name})

      const previous = host
      host = await openHost(browser, servers.hostUrl)
      await previous.close()
      await mountHeld(host, ATTEMPTS_DOCUMENT)
      await settle(host)
      expect(await ranSoFar()).toEqual([])
    })

    it('does not follow a javascript: link, which an unsandboxed frame does', async () => {
      await mount(host, 'control', LINK)
      await host.page.frameLocator('#mount iframe').locator('a').click()
      await untilReported(host, {ran: 'a javascript: link'})

      const previous = host
      host = await openHost(browser, servers.hostUrl)
      await previous.close()
      await mountHeld(host, LINK)
      await host.page.frameLocator('#mount iframe').frameLocator('iframe').locator('a').click()
      await settle(host)
      expect(await ranSoFar()).toEqual([])
    })

    it('leaves the keyboard with the app', async () => {
      expect(await typeIntoApp(mounted => mountHeld(mounted, KEYBOARD_THIEF))).toEqual({inApp: 'abcde', stolen: ''})
    })

    it('sends nothing over WebRTC', async () => {
      expect(await stunPacketsFrom(mounted => mountHeld(mounted, stunProbe()).then(() => settle(mounted)))).toBe(0)
    })

    it('still renders the document and sizes the frame to it', async () => {
      await mountHeld(host, '<style>body{margin:0}#box{height:640px;color:rgb(1,2,3)}</style><div id="box">text</div>')
      await vi.waitFor(async () => expect(await frameHeight(host)).toBe(640), {timeout: 5_000, interval: 25})
      const box = host.page.frameLocator('#mount iframe').frameLocator('iframe').locator('#box')
      expect(await box.evaluate(element => getComputedStyle(element).color)).toBe('rgb(1, 2, 3)')
    })

    it('starts running when allowed and holds again when stopped', async () => {
      const source = `<p>text</p>${script(`top.postMessage({ran: 'an inline script'}, '*')`)}`
      await mountHeld(host, source)
      await settle(host)
      expect(await ranSoFar()).toEqual([])

      await mount(host, 'sandboxed', source)
      await untilReported(host, {ran: 'an inline script'})

      await clearReports(host)
      await mountHeld(host, source)
      await settle(host)
      expect(await ranSoFar()).toEqual([])
    })

    it('adds nothing to the page\'s history when it starts or stops', async () => {
      const source = `<p>text</p>${script(ARMED)}`
      await mountHeld(host, source)
      const before = await historyLength(host)
      await mountRunning(host, source)
      await mountHeld(host, source)
      await settle(host)
      expect(await historyLength(host)).toBe(before)
    })

    // Holds on Chromium with or without the frame's key. It's for the engines whose
    // joint history behaves differently.
    it('does not run again when Back returns past a stop', async () => {
      // After load: a fragment navigation during load replaces the entry.
      const source = `<p>text</p>${script(`
        top.postMessage({ran: 'an inline script'}, '*')
        addEventListener('load', () => setTimeout(() => { location.hash = '#moved'; top.postMessage('moved', '*') }, 50))
      `)}`
      const before = await historyLength(host)
      await mountRunning(host, source)
      await untilReported(host, 'moved')
      await mountHeld(host, source)
      await settle(host)
      const added = await historyLength(host) - before
      expect(added > 0).toBe(FRAGMENT_ADDS_TO_HISTORY[engine])

      await clearReports(host)
      for (let step = 0; step < added; step += 1) {
        await host.page.evaluate(() => history.back())
        await host.page.waitForTimeout(150)
      }
      await settle(host)
      expect(await ranSoFar()).toEqual([])
    })

    it('still sends a prerender GET on the engines named above, with nothing computed in it', async () => {
      await mountHeld(host, `<link rel="prerender" href="${decoy('prerender')}?fixed">`)
      await settle(host)
      expect(servers.decoyHits()).toEqual(PRERENDER_REACHES_THE_NETWORK[engine] ? ['/hit/prerender'] : [])
    })
  })

  // Not promises: the boundary's known gaps, pinned where they were measured, so a
  // browser closing one shows up here.
  describe('what a document can still do', () => {
    it('takes the keyboard from the app with no click, on the engines named above', async () => {
      expect(await typeIntoApp(host => mountRunning(host, '<p>harmless</p>'))).toEqual({inApp: 'abcde', stolen: ''})
      const taken = await typeIntoApp(host => mountRunning(host, KEYBOARD_THIEF))
      expect(taken.stolen.length > 0).toBe(TAKES_THE_KEYBOARD[engine])
    })

    it('sends a GET with a link rel=prerender on the engines named above', async () => {
      const hitsFrom = async (shape: Shape) => {
        servers.reset()
        const host = await openHost(browser, servers.hostUrl)
        await mount(host, shape, `<link rel="prerender" href="${decoy('prerender')}?data=secret">${script(ARMED)}`)
        await untilReported(host, 'armed')
        await vi.waitFor(() => expect(servers.decoyHits()).not.toEqual([]), {timeout: 3_000}).catch(() => {})
        await host.close()
        return servers.decoyHits()
      }

      const expected = PRERENDER_REACHES_THE_NETWORK[engine] ? ['/hit/prerender'] : []
      expect(await hitsFrom('control')).toEqual(expected)
      expect(await hitsFrom('sandboxed')).toEqual(expected)
    })

    it('reaches a host of its choosing over WebRTC', async () => {
      expect(await stunPacketsFrom(host => mount(host, 'control', stunProbe() + script(ARMED)).then(() => untilReported(host, 'armed')))).toBeGreaterThan(0)
      expect(await stunPacketsFrom(host => mountRunning(host, stunProbe()))).toBeGreaterThan(0)
    })

    // Measured on Chromium only. No script is involved, so holding doesn't stop these,
    // but what it takes has no way out of a held document.
    const FRAGMENT_THIEF = `<meta http-equiv="refresh" content="1"><iframe srcdoc="<input id=f><meta http-equiv=refresh content='0;url=#f'>"></iframe>`

    it.runIf(engine === 'chromium')('takes the keyboard while held, through a fragment link in a refresh', async () => {
      const taken = await typeIntoApp(host => mountHeld(host, FRAGMENT_THIEF))
      expect(taken.inApp).not.toBe('abcde')
      expect(taken.stolen).toBe('')
    })

    it.runIf(engine === 'chromium')('adds to the page\'s history while held, the same way', async () => {
      const host = await openHost(browser, servers.hostUrl)
      await mountHeld(host, FRAGMENT_THIEF)
      const before = await historyLength(host)
      await expect.poll(() => historyLength(host), {timeout: 10_000}).toBeGreaterThan(before)
      await host.close()
    })

    it.runIf(engine === 'chromium')('can overwrite the clipboard after a click inside it', async () => {
      const host = await openHost(browser, servers.hostUrl)
      await mount(host, 'sandboxed', `<button style="display:block;height:120px;width:100%" onclick="
        document.getElementById('source').select()
        top.postMessage({copied: document.execCommand('copy')}, '*')
      ">go</button><textarea id="source">x</textarea>${script(ARMED)}`)
      await untilReported(host, 'armed')
      await clickFrame(host)
      await untilReported(host, {copied: true})
      await host.close()
    })
  })
})
