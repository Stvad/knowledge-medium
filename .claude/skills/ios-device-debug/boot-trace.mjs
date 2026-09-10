// Inject a worker-message tracer via Page.setBootstrapScript, reload, then dump
// the trace + startup marks. Usage: MATCH=github node ios-boot-trace.mjs [waitSecs]
const LIST = process.env.IWDP || 'http://localhost:9221'
const MATCH = process.env.MATCH || 'github'
const WAIT = Number(process.argv[2] || 15)
process.on('unhandledRejection', e => { console.error('trace:', e?.message || e); process.exit(1) })

const dev = (await (await fetch(LIST + '/json')).json())[0]
const pages = await (await fetch('http://' + dev.url + '/json')).json()
const page = pages.find(p => (p.url || '').includes(MATCH) && p.title !== 'ServiceWorker')
if (!page) { console.error('no page'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let outerId = 0, innerId = 0
const pending = new Map()
let target = null
const targets = []
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Target.targetCreated') {
    const ti = m.params.targetInfo
    targets.push(ti)
    if (!target || ti.type === 'page') target = ti
    console.error('target created', ti.targetId, ti.type)
  } else if (m.method === 'Target.targetDestroyed') {
    console.error('target destroyed', m.params.targetId)
  } else if (m.method === 'Target.dispatchMessageFromTarget') {
    const inner = JSON.parse(m.params.message)
    if (inner.id && pending.has(inner.id)) { pending.get(inner.id)(inner); pending.delete(inner.id) }
  }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
await new Promise(r => setTimeout(r, 1500))
if (!target) { console.error('no target'); process.exit(1) }
const send = (method, params = {}) => new Promise(res => {
  const id = ++innerId
  pending.set(id, res)
  ws.send(JSON.stringify({ id: ++outerId, method: 'Target.sendMessageToTarget',
    params: { targetId: target.targetId, message: JSON.stringify({ id, method, params }) } }))
})
const evalIn = async (expr) => {
  const ev = (await send('Runtime.evaluate', { expression: `Promise.resolve((${expr}))`, returnByValue: false })).result || {}
  if (ev.wasThrown) throw new Error('eval threw: ' + JSON.stringify(ev.result))
  const aw = (await send('Runtime.awaitPromise', { promiseObjectId: ev.result.objectId, returnByValue: true })).result || {}
  if (aw.wasThrown) throw new Error('eval rejected: ' + JSON.stringify(aw.result))
  return aw.result?.value
}

const HOOK = `(() => {
  const T = []; window.__dbTrace = T;
  const now = () => Math.round(performance.now() * 10) / 10;
  const seen = new WeakSet();
  const logOut = (label, msg) => { try { if (msg && msg.id) T.push({t: now(), d: 'out', w: label, id: msg.id, p: (msg.path || []).join('.'), a: JSON.stringify(msg.argumentList || []).slice(0, 320)}) } catch {} };
  const logIn = (label, m, ports) => { try { if (m && m.id) T.push({t: now(), d: 'in', w: label, id: m.id, ty: m.type, np: ports}) } catch {} };
  const wrap = (label, port) => {
    if (!port || seen.has(port)) return; seen.add(port);
    const orig = port.postMessage.bind(port);
    port.postMessage = (msg, ...rest) => { logOut(label, msg); const tr = Array.isArray(rest[0]) ? rest[0] : (rest[0] && rest[0].transfer); if (tr) for (const x of tr) if (x instanceof MessagePort) wrap(label + '>', x); return orig(msg, ...rest) };
    port.addEventListener('message', ev => { logIn(label, ev.data, (ev.ports || []).length); for (const x of (ev.ports || [])) wrap(label + '<', x) });
  };
  const MC = window.MessageChannel;
  const PMC = function () { const c = new MC(); wrap('MC1', c.port1); wrap('MC2', c.port2); return c };
  PMC.prototype = MC.prototype; window.MessageChannel = PMC;
  const SW = window.SharedWorker;
  if (SW) {
    const P = function (...args) { const w = new SW(...args); const label = 'S:' + String(args[0]).split('/').pop().slice(0, 24); T.push({t: now(), ev: label}); wrap(label, w.port); return w };
    P.prototype = SW.prototype; window.SharedWorker = P;
  }
  const W = window.Worker;
  const PW = function (...args) { const w = new W(...args); const label = 'W:' + String(args[0]).split('/').pop().slice(0, 24); T.push({t: now(), ev: label}); wrap(label, w); return w };
  PW.prototype = W.prototype; window.Worker = PW;
  window.addEventListener('DOMContentLoaded', () => T.push({t: now(), ev: 'DOMContentLoaded'}));
})()`

await send('Runtime.enable')
await send('Page.enable')
const SHIM = process.env.SHIM ? `window.requestIdleCallback = (cb, o) => setTimeout(() => cb({didTimeout: false, timeRemaining: () => 50}), 1); window.cancelIdleCallback = clearTimeout;` : ''
const r = await send('Page.setBootstrapScript', { source: SHIM + HOOK })
if (r.error) { console.error('setBootstrapScript error', JSON.stringify(r.error)); process.exit(2) }
console.error('bootstrap script set; reloading')
await send('Page.reload')
await new Promise(r => setTimeout(r, WAIT * 1000))
console.error('targets seen:', targets.map(t => t.targetId + ':' + t.type).join(', '), '→ using', target.targetId)
const out = await evalIn(`(async () => {
  const t = await import('@/utils/startupTimeline.js')
  const marks = {}; for (const [k, v] of Object.entries(t.getStartupTimeline().marks)) marks[k] = Math.round(v)
  return { marks, hooked: !!window.__dbTrace, n: (window.__dbTrace || []).length, trace: window.__dbTrace || [] }
})()`)
await send('Page.setBootstrapScript', {})
console.log(JSON.stringify(out))
process.exit(0)
