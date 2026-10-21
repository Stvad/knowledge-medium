// Drive the live iPhone/iPad app tab (protocol in inspector.mjs).
//
//   node ios.mjs eval '<js expression or async IIFE>'
//   node ios.mjs console <seconds>
//   node ios.mjs pages
import { connect, evalIn, findPage } from './inspector.mjs'

const [mode, arg] = process.argv.slice(2)

if (mode === 'pages') { for (const p of (await findPage()).pages) console.log((p.url || '(no url)')); process.exit(0) }

const { s } = await connect()

if (mode === 'eval') {
  const v = await evalIn(s, arg)
  console.log('value' in v ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2)) : JSON.stringify(v, null, 2))
  process.exit(0)
}

if (mode === 'console') {
  await s.send('Console.enable')
  s.onInner(m => {
    if (m.method === 'Console.messageAdded') {
      const x = m.params.message
      console.log(`[${x.level}] ${x.text}` + (x.url ? `  (${(x.url || '').split('/').pop()}:${x.line || '?'})` : ''))
    }
  })
  const secs = Number(arg) || 12
  console.error(`— capturing console ${secs}s; reproduce the bug on the device now —`)
  setTimeout(() => process.exit(0), secs * 1000)
} else { console.error('usage: node ios.mjs eval <js> | console <seconds> | pages'); process.exit(1) }
