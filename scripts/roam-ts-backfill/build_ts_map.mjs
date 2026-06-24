// Build the Roam create-time/edit-time → block-id mapping for the timestamp
// backfill. Non-daily nodes use the importer's deterministic id
// (roamBlockId); daily PAGES use dailyNoteBlockId(ws, iso) — iso derived
// title-first (matching ids.ts resolveDailyPage precedence), then uid
// (MM-DD-YYYY), then :log/id. Daily-page ids are validated against the live
// DB separately; anything that doesn't match is reported there.
//
// Out: tmp/roam_ts_map.csv  (id,create_time,edit_time)  + .json
//
// Workspace-specific: set WS to the target workspace id and pass the Roam
// export path as argv[2]. The namespace constants are the app's public
// id-derivation namespaces (ids.ts / dailyNotes.ts) and do not change.
import { v5 as uuidv5 } from 'uuid'
import fs from 'fs'

const EXPORT = process.argv[2] || 'tmp/roam-export.json'
const WS = 'ef43b424-80ba-4967-b587-a4c32efd8071' // workspace-specific (ff-vlad-dev)
const ROAM_IMPORT_NS = 'b8d6f1c2-7e9a-4f4d-a4f1-2c0a3a6e7f01'   // ids.ts
const DAILY_NOTE_NS = '53421e08-2f31-42f8-b73a-43830bb718f1'    // dailyNotes.ts

const roamBlockId = uid => uuidv5(`${WS}:roam:${uid}`, ROAM_IMPORT_NS)
const dailyNoteBlockId = iso => uuidv5(`${WS}:${iso}`, DAILY_NOTE_NS)

const MONTHS = {January:1,February:2,March:3,April:4,May:5,June:6,July:7,
  August:8,September:9,October:10,November:11,December:12}
const pad = n => String(n).padStart(2, '0')

// iso from a literal daily-page title: ISO form or Roam long form
// ("April 28th, 2026"). Returns null otherwise.
const isoFromTitle = t => {
  if (typeof t !== 'string') return null
  const s = t.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(st|nd|rd|th), (\d{4})$/.exec(s)
  if (!m) return null
  return `${m[4]}-${pad(MONTHS[m[1]])}-${pad(Number(m[2]))}`
}
const isoFromUid = u => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(u || '')
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null
}
const isoFromLogId = id => {
  if (typeof id !== 'number' || !Number.isFinite(id)) return null
  const d = new Date(id)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y < 1000 || y > 9999) return null
  return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const isDailyPage = n =>
  isoFromTitle(n.title) !== null || isoFromUid(n.uid) !== null || n[':log/id'] !== undefined

const data = JSON.parse(fs.readFileSync(EXPORT, 'utf8'))
const rows = []
let noCt = 0, dailyNoIso = 0, dailyCount = 0

const walk = (n, topLevel) => {
  if (!n || typeof n !== 'object') return
  const uid = n.uid || n[':block/uid']
  const ct = n['create-time']
  const et = n['edit-time'] ?? ct
  if (uid && ct != null) {
    let id
    if (topLevel && isDailyPage(n)) {
      dailyCount++
      const iso = isoFromTitle(n.title) ?? isoFromUid(uid) ?? isoFromLogId(n[':log/id'])
      if (!iso) { dailyNoIso++; id = null } else id = dailyNoteBlockId(iso)
    } else {
      id = roamBlockId(uid)
    }
    if (id) rows.push({ id, ct, et })
  } else if (uid && ct == null) noCt++
  for (const c of (n.children || [])) walk(c, false)
}
for (const pg of data) walk(pg, true)

// de-dup by id (last wins)
const byId = new Map()
for (const r of rows) byId.set(r.id, r)
const out = [...byId.values()]

const csv = ['id,create_time,edit_time', ...out.map(r => `${r.id},${r.ct},${r.et}`)].join('\n') + '\n'
fs.writeFileSync('tmp/roam_ts_map.csv', csv)
fs.writeFileSync('tmp/roam_ts_map.json', JSON.stringify(out))
console.log(`mapped unique ids: ${out.length}  (daily pages: ${dailyCount}, daily w/o iso: ${dailyNoIso}, nodes w/o create-time: ${noCt})`)
console.log('wrote tmp/roam_ts_map.csv + .json')
