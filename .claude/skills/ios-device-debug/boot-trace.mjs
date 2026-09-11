// Reload the app tab with a hook injected BEFORE any page script (Page.setBootstrapScript,
// which survives a same-origin reload), then dump every DB-worker round trip
// (comlink messages over the transferred MessagePorts, SQL text included), the
// startup-timeline marks and every resource-timing entry.
//
//   MATCH=github node boot-trace.mjs [waitSecs]        # then: node analyze-trace.js out.json
//   PRELUDE='<js>' …                                    # extra code to run before the hook
import { connect, evalIn } from './inspector.mjs'

const WAIT = Number(process.argv[2] || 15)
const { s } = await connect()

const HOOK = `(() => {
  performance.setResourceTimingBufferSize(20000);
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

await s.send('Page.enable')
await s.send('Page.setBootstrapScript', { source: (process.env.PRELUDE || '') + ';' + HOOK })
console.error('bootstrap script set; reloading')
await s.send('Page.reload')
await new Promise(r => setTimeout(r, WAIT * 1000))
const out = await evalIn(s, `(async () => {
  const t = await import('@/utils/startupTimeline.js')
  const marks = {}; for (const [k, v] of Object.entries(t.getStartupTimeline().marks)) marks[k] = Math.round(v)
  const res = performance.getEntriesByType('resource')
  return { marks, hooked: !!window.__dbTrace, n: (window.__dbTrace || []).length, trace: window.__dbTrace || [],
    resources: res.map(e => [Math.round(e.startTime), Math.round(e.responseEnd), e.name.replace(location.origin + '/knowledge-medium/', '')]) }
})()`)
await s.send('Page.setBootstrapScript', {})
console.log(JSON.stringify(out.value))
process.exit(0)
