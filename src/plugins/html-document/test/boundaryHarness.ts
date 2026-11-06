/** Servers and browser plumbing for the boundary suite: a host origin that serves
 *  `boundaryHost.tsx`, a decoy origin standing in for the attacker's server, and
 *  a UDP socket standing in for their STUN server. */

import dgram from 'node:dgram'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {networkInterfaces} from 'node:os'
import {resolve} from 'node:path'
import react from '@vitejs/plugin-react'
import {chromium, firefox, webkit, type Browser, type Page} from 'playwright'
import {build, type Rollup} from 'vite'

const ENGINES = {chromium, webkit, firefox}

export type Engine = keyof typeof ENGINES

/** Every engine unless narrowed, and a missing browser fails with Playwright's
 *  install instructions: a boundary suite that quietly skips an engine reads as
 *  coverage it does not have. */
export const selectedEngines = (): Engine[] =>
  (process.env.KM_BOUNDARY_ENGINES?.split(',') ?? Object.keys(ENGINES)) as Engine[]

export const launchEngine = (engine: Engine): Promise<Browser> => ENGINES[engine].launch({headless: true})

const bundleHost = async (): Promise<string> => {
  const here = import.meta.dirname
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [react()],
    resolve: {alias: {'@': resolve(here, '../../..')}},
    build: {
      write: false,
      minify: false,
      rollupOptions: {input: resolve(here, 'boundaryHost.tsx')},
    },
  })
  const output = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput
  const entry = output.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry)
  if (entry?.type !== 'chunk') throw new Error('host bundle has no entry chunk')
  return entry.code
}

/** Every IPv4 address of this machine. One STUN server on loopback alone would
 *  read an engine that refuses loopback ICE as the sandbox stopping it, and a
 *  machine's firewall can refuse the other addresses. */
const ipv4Addresses = (): string[] =>
  Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4').map(address => address?.address ?? '')

const listen = (server: http.Server): Promise<string> =>
  new Promise(done => server.listen(0, '127.0.0.1', () =>
    done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

export interface BoundaryServers {
  hostUrl: string
  decoyUrl: string
  stunUrls: string[]
  /** Paths the decoy has been asked for, including refused WebSocket upgrades. */
  decoyHits: () => string[]
  stunPackets: () => number
  reset: () => void
  close: () => Promise<void>
}

export const startServers = async (): Promise<BoundaryServers> => {
  const hostScript = await bundleHost()
  const host = http.createServer((request, response) => {
    if (request.url === '/host.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(hostScript)
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>host</title><div id="secret">KM_SECRET_dom</div><div id="mount" style="width:600px"></div><script type="module" src="/host.js"></script>')
  })

  let hits: string[] = []
  const decoy = http.createServer((request, response) => {
    hits.push((request.url ?? '').split('?')[0])
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Content-Type', request.url?.endsWith('.css') ? 'text/css' : request.url?.endsWith('.js') ? 'text/javascript' : 'text/html')
    response.end('')
  })
  decoy.on('upgrade', (request, socket) => {
    hits.push((request.url ?? '').split('?')[0])
    socket.destroy()
  })

  let packets = 0
  const stun = dgram.createSocket('udp4')
  stun.on('message', () => {
    packets += 1
  })
  await new Promise<void>(done => stun.bind(0, '0.0.0.0', done))

  const [hostUrl, decoyUrl] = await Promise.all([listen(host), listen(decoy)])
  return {
    hostUrl,
    decoyUrl,
    stunUrls: ipv4Addresses().map(address => `stun:${address}:${stun.address().port}`),
    decoyHits: () => [...hits],
    stunPackets: () => packets,
    reset: () => {
      hits = []
      packets = 0
    },
    close: async () => {
      host.closeAllConnections()
      decoy.closeAllConnections()
      stun.close()
      await Promise.all([
        new Promise(done => host.close(done)),
        new Promise(done => decoy.close(done)),
      ])
    },
  }
}

export interface HostPage {
  page: Page
  popups: () => number
  downloads: () => number
  dialogs: () => number
  /** What frames posted to the top window. */
  reports: () => Promise<unknown[]>
  close: () => Promise<void>
}

export const openHost = async (browser: Browser, hostUrl: string): Promise<HostPage> => {
  const context = await browser.newContext()
  const page = await context.newPage()
  let popups = 0
  let downloads = 0
  let dialogs = 0
  context.on('page', () => {
    popups += 1
  })
  page.on('download', () => {
    downloads += 1
  })
  page.on('dialog', dialog => {
    dialogs += 1
    void dialog.dismiss().catch(() => {})
  })
  await page.goto(`${hostUrl}/?q=KM_SECRET_query#KM_SECRET_hash`)
  await page.waitForFunction(() => typeof window.mountSandboxed === 'function')
  await page.evaluate(() => window.secretsReady)
  return {
    page,
    popups: () => popups,
    downloads: () => downloads,
    dialogs: () => dialogs,
    reports: () => page.evaluate(() => window.reports),
    close: () => context.close(),
  }
}
