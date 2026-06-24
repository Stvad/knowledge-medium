#!/usr/bin/env node
/**
 * Roam location pages → Place blocks.
 *
 *  Reads coord-shaped Roam location pages (those whose `roam:location` is
 *  "lat,lng"), resolves each through the legacy Google Places Details
 *  API by `cid=` query param (works for both `?cid=N` and
 *  `?ftid=0x*:0x<hex>` shapes — the FTID's second hex IS the CID in
 *  hex), then applies the upgrade through the browser tab via
 *  `kmagent eval`. Idempotent — pages already typed `Place` are skipped.
 *
 *  Why two transports:
 *    - Legacy Places API rejects referrer-restricted browser keys and
 *      is not CORS-enabled, so we have to call it server-side with an
 *      unrestricted temp key (LEGACY_PLACES_KEY).
 *    - Mutations have to go through `repo.tx` for proper type-add /
 *      property codec / alias-index / references-processor wiring, so
 *      the apply step runs in the browser via `kmagent eval` (which
 *      auto-binds `repo` and `db` into the eval scope).
 *
 *  Usage:
 *    LEGACY_PLACES_KEY=AIza... node scripts/migrate-roam-locations.mjs --dry-run --limit 5
 *    LEGACY_PLACES_KEY=AIza... node scripts/migrate-roam-locations.mjs
 *
 *  Options:
 *    --dry-run    Resolve + report; no mutations.
 *    --limit N    Process only the first N pages (testing).
 *    --profile P  kmagent profile (default: AGENT_RUNTIME_PROFILE or ff-vlad-dev).
 *    --workspace W  Workspace id (default: runtime-summary's active workspace).
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const KMAGENT = join(repoRoot, 'packages/agent-cli/dist/cli.js')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

const DRY = flag('--dry-run')
const LIMIT = opt('--limit') ? Number(opt('--limit')) : null
const PROFILE = opt('--profile') ?? process.env.AGENT_RUNTIME_PROFILE ?? 'ff-vlad-dev'
const KEY = process.env.LEGACY_PLACES_KEY
// Drift reporting only — CID resolution is by-design unique
// (same CID = same place forever), so we trust the API result and
// migrate regardless of coord drift. A real-data run showed the only
// "drifts" were polygon centroids: Yellowstone NP (19km drift, same
// place), Chicago / Weehawken (city/township centroids vs user pin).
// Drift gets logged for context but doesn't gate migration.
const COORD_DRIFT_LOG_M = 500

if (!KEY) {
  console.error('LEGACY_PLACES_KEY env var required (unrestricted temp key for legacy Places API)')
  process.exit(1)
}

const kmagent = (...cliArgs) => execFileSync('node', [KMAGENT, '--profile', PROFILE, ...cliArgs], {
  maxBuffer: 64 * 1024 * 1024,
}).toString()
const kmagentJson = (...cliArgs) => JSON.parse(kmagent(...cliArgs))

const workspaceId = opt('--workspace') ?? kmagentJson('runtime-summary').activeWorkspaceId
const mode = DRY ? 'DRY RUN' : 'APPLY'
console.error(`[migrate] workspace=${workspaceId} profile=${PROFILE} mode=${mode}${LIMIT ? ` limit=${LIMIT}` : ''}`)

// ─── 1. Candidate page list ──────────────────────────────────────────

const coordGlob1 = "json_extract(properties_json, '$.roam:location') GLOB '-*' || '*,*' || '-*' || '*'"
const coordGlob2 = "json_extract(properties_json, '$.roam:location') GLOB '[0-9]*,*[0-9]*'"
const allRows = kmagentJson(
  'sql', 'all',
  `SELECT id, content, properties_json
     FROM blocks
    WHERE workspace_id = ? AND deleted = 0
      AND (${coordGlob1} OR ${coordGlob2})`,
  JSON.stringify([workspaceId]),
)
const rows = LIMIT ? allRows.slice(0, LIMIT) : allRows
console.error(`[migrate] ${allRows.length} candidate pages${LIMIT ? `, processing ${rows.length}` : ''}`)

// ─── 2. CID extraction ───────────────────────────────────────────────

const extractCid = (url) => {
  if (!url) return null
  const cidMatch = url.match(/[?&]cid=(\d+)/)
  if (cidMatch) return cidMatch[1]
  // ftid format: 0x<hex1>:0x<hex2> — second hex IS the CID in hex
  const ftidMatch = url.match(/[?&]ftid=0x[0-9a-fA-F]+:0x([0-9a-fA-F]+)/)
  if (ftidMatch) {
    try { return BigInt('0x' + ftidMatch[1]).toString() } catch { return null }
  }
  return null
}

// ─── 3. Coord drift ──────────────────────────────────────────────────

const haversineMeters = (a, b) => {
  const R = 6_371_008.8
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

// ─── 4. Per-page resolve loop ────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const plans = []
const misses = []  // Full details per skipped page, written to a sidecar for review
const reasons = {already: 0, no_url: 0, no_cid: 0, api_fail: 0, ok: 0}

let processed = 0
for (const row of rows) {
  processed += 1
  const props = JSON.parse(row.properties_json)
  const types = Array.isArray(props.types) ? props.types : []
  if (types.includes('place')) { reasons.already += 1; continue }

  const url = props['roam:url']
  if (!url) {
    reasons.no_url += 1
    console.error(`  NO_URL    ${row.content}`)
    misses.push({reason: 'no_url', pageId: row.id, pageName: row.content})
    continue
  }
  const cid = extractCid(url)
  if (!cid) {
    reasons.no_cid += 1
    console.error(`  NO_CID    ${row.content}  url=${url}`)
    misses.push({reason: 'no_cid', pageId: row.id, pageName: row.content, url})
    continue
  }

  const fields = 'place_id,name,geometry,formatted_address,website,formatted_phone_number,types,url'
  const apiUrl = `https://maps.googleapis.com/maps/api/place/details/json?cid=${cid}&key=${KEY}&fields=${fields}`
  let data
  try {
    data = await (await fetch(apiUrl)).json()
  } catch (err) {
    reasons.api_fail += 1
    console.error(`  API_ERR   ${row.content}  ${err.message}`)
    misses.push({reason: 'api_error', pageId: row.id, pageName: row.content, error: err.message, cid})
    continue
  }
  if (data.status !== 'OK') {
    reasons.api_fail += 1
    console.error(`  API_DENY  ${row.content}  status=${data.status} ${data.error_message ?? ''}`)
    misses.push({reason: 'api_deny', pageId: row.id, pageName: row.content, cid, status: data.status, error_message: data.error_message ?? null})
    continue
  }

  const [roamLatStr, roamLngStr] = (props['roam:location'] ?? '').split(',')
  const roamCoord = {lat: parseFloat(roamLatStr), lng: parseFloat(roamLngStr)}
  const apiCoord = {lat: data.result.geometry.location.lat, lng: data.result.geometry.location.lng}
  const drift = haversineMeters(roamCoord, apiCoord)
  if (drift > COORD_DRIFT_LOG_M) {
    // Logged but not skipped — see comment on COORD_DRIFT_LOG_M.
    console.error(`  DRIFT     ${row.content}  ${Math.round(drift)}m apart (migrating anyway)`)
  }

  plans.push({
    pageId: row.id,
    pageName: row.content,
    placeId: data.result.place_id,
    lat: apiCoord.lat,
    lng: apiCoord.lng,
    address: data.result.formatted_address,
    website: data.result.website,
    phone: data.result.formatted_phone_number,
    googleMapsUrl: data.result.url,
    categories: Array.isArray(data.result.types) ? data.result.types : [],
    driftM: Math.round(drift),
  })
  reasons.ok += 1
  if (processed % 25 === 0) {
    console.error(`  [${processed}/${rows.length}] ${reasons.ok} ok / ${reasons.api_fail} fail / ${reasons.already} already`)
  }
  await sleep(100)  // ~10 req/s, polite
}

console.error('')
console.error(`[migrate] resolve summary:`)
console.error(`  ok:       ${reasons.ok}`)
console.error(`  already:  ${reasons.already} (already Place-typed)`)
console.error(`  api_fail: ${reasons.api_fail}`)
console.error(`  no_url:   ${reasons.no_url}`)
console.error(`  no_cid:   ${reasons.no_cid}`)
console.error('')

if (misses.length > 0) {
  const missesPath = `/tmp/migrate-roam-misses-${process.pid}.json`
  writeFileSync(missesPath, JSON.stringify(misses, null, 2))
  console.error(`[migrate] ${misses.length} misses logged to ${missesPath} for review`)
  console.error('')
}

if (DRY) {
  console.log(JSON.stringify(plans, null, 2))
  console.error(`[migrate] DRY RUN — ${plans.length} pages would be migrated`)
  process.exit(0)
}

if (plans.length === 0) {
  console.error('[migrate] nothing to apply')
  process.exit(0)
}

// ─── 5. Apply phase (browser via kmagent eval) ──────────────────────
//
//  Manifest is embedded directly. A `--data` flag on `kmagent eval` is
//  a follow-up improvement — see the spawned chip in conversation.

const APPLY_SCRIPT = `
const PLANS = ${JSON.stringify(plans)}
const WS = ${JSON.stringify(workspaceId)}

const props = await import('/src/plugins/geo/properties.ts')
const types = await import('/src/plugins/geo/blockTypes.ts')
const coreProps = await import('/src/data/properties.ts')
const api = await import('/src/data/api/index.ts')
const orderMod = await import('/src/data/orderKey.ts')
const locMod = await import('/src/plugins/geo/locationsPage.ts')

const {PLACE_TYPE} = types
const {ChangeScope} = api
const {aliasesProp} = coreProps

const migrated = {ok: 0, fail: 0, errors: []}

for (const p of PLANS) {
  try {
    const live = await repo.load(p.pageId)
    if (!live) { migrated.fail++; migrated.errors.push({page: p.pageName, why: 'not found'}); continue }
    const existingTypes = Array.isArray(live.properties.types) ? live.properties.types : []
    if (existingTypes.includes(PLACE_TYPE)) { migrated.ok++; continue }

    const existingAliases = Array.isArray(live.properties[aliasesProp.name])
      ? live.properties[aliasesProp.name] : []
    const machineAlias = 'place:' + p.placeId
    const nextAliases = existingAliases.includes(machineAlias)
      ? existingAliases : [...existingAliases, machineAlias]
    const typeSnapshot = repo.snapshotTypeRegistries()

    await repo.tx(async tx => {
      if (!existingAliases.includes(machineAlias)) {
        await tx.setProperty(p.pageId, aliasesProp, nextAliases)
      }
      await repo.addTypeInTx(tx, p.pageId, PLACE_TYPE, {[aliasesProp.name]: nextAliases}, typeSnapshot)
      await tx.setProperty(p.pageId, props.placeLatProp, p.lat)
      await tx.setProperty(p.pageId, props.placeLngProp, p.lng)
      if (p.address) await tx.setProperty(p.pageId, props.placeAddressProp, p.address)
      await tx.setProperty(p.pageId, props.placeGooglePlaceIdProp, p.placeId)
      if (p.googleMapsUrl) await tx.setProperty(p.pageId, props.placeGoogleMapsUrlProp, p.googleMapsUrl)
      if (p.website) await tx.setProperty(p.pageId, props.placeWebsiteProp, p.website)
      if (p.phone) await tx.setProperty(p.pageId, props.placePhoneProp, p.phone)
      if (p.categories && p.categories.length > 0) {
        await tx.setProperty(p.pageId, props.placeCategoriesProp, [...p.categories])
      }
    }, {scope: ChangeScope.BlockDefault, description: 'migrate roam location'})
    migrated.ok++
  } catch (err) {
    migrated.fail++
    migrated.errors.push({page: p.pageName, why: String(err?.message ?? err)})
  }
}

// "Imported from Roam" index bullet under Locations page
const locationsPage = await locMod.getOrCreateLocationsPage(repo, WS)
const indexAlias = 'imported-from-roam-index'
const existingIndex = await repo.query.aliasLookup({workspaceId: WS, alias: indexAlias}).load()
let indexId = existingIndex && existingIndex.id

if (!indexId) {
  indexId = crypto.randomUUID()
  await repo.tx(async tx => {
    await tx.create({
      id: indexId,
      workspaceId: WS,
      parentId: locationsPage.id,
      orderKey: orderMod.keyAtEnd(),
      content: 'Imported from Roam',
    })
    await tx.setProperty(indexId, aliasesProp, [indexAlias])
  }, {scope: ChangeScope.BlockDefault, description: 'create imported-from-roam index'})
}

// Skip duplicate wikilink children by content match
const childRows = await db.getAll(
  'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0',
  [indexId],
)
const seen = new Set(childRows.map(c => c.content))

let linksCreated = 0
for (const p of PLANS) {
  const content = '[[' + p.pageName + ']]'
  if (seen.has(content)) continue
  await repo.tx(async tx => {
    await tx.create({
      id: crypto.randomUUID(),
      workspaceId: WS,
      parentId: indexId,
      orderKey: orderMod.keyAtEnd(),
      content,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'imported-from-roam wikilink'})
  linksCreated++
}

return {migrated, linksCreated, indexId}
`

const tmpPath = `/tmp/migrate-roam-apply-${process.pid}.js`
writeFileSync(tmpPath, APPLY_SCRIPT)
console.error(`[migrate] applying via kmagent eval (script at ${tmpPath})`)

const applyOut = kmagent('eval', '--file', tmpPath)
console.error('[migrate] apply result:')
console.error(applyOut)
