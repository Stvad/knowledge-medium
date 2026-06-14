#!/usr/bin/env node
/**
 * Roam `roam:location` strings → typed `location` refs (+ Place promotion).
 *
 *  Reads three precomputed inputs from /tmp (built by the dry-run scripts):
 *    1. /tmp/promote-list.json — 117 distinct wikilink targets to promote
 *       to Place blocks (city/country/POI pages get types += 'place' +
 *       place:lat/lng/address/googlePlaceId + place:<placeId> alias).
 *    2. /tmp/resolved.json — 862 source-row → chosen-target-page resolutions
 *       (the picker that chose most-specific non-struck target per row).
 *    3. /tmp/freetext-geocoded.json — 3 free-text rows pre-geocoded
 *       (Seattle, Fairfield, Stanford Family Medicine).
 *
 *  Why those inputs are precomputed (not inline here):
 *    Each one required a kmagent eval to either hit Google or run the
 *    aliasLookup picker against live data. Keeping them separate kept the
 *    interactive review loop fast — we iterated buckets/picker without
 *    touching this script.
 *
 *  Idempotent:
 *    - Promotions skip pages that already have the `place` type.
 *    - Location-ref writes overwrite any existing `location` prop value
 *      (treated as authoritative).
 *    - `roam:location` is NEVER modified or removed (per memory:
 *      preserve-import-source-props).
 *
 *  Usage:
 *    node scripts/migrate-roam-location-refs.mjs --dry-run
 *    node scripts/migrate-roam-location-refs.mjs
 *
 *  Options:
 *    --dry-run    Print plan + counts; no mutations.
 *    --profile P  kmagent profile (default: ff-vlad-dev).
 *    --workspace W  Workspace id (default: runtime-summary's active workspace).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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

const kmagent = (...cliArgs) => execFileSync('node', [KMAGENT, '--profile', PROFILE, ...cliArgs], {
  maxBuffer: 64 * 1024 * 1024,
}).toString()
const kmagentJson = (...cliArgs) => JSON.parse(kmagent(...cliArgs))

const workspaceId = opt('--workspace') ?? kmagentJson('runtime-summary').activeWorkspaceId
const mode = DRY ? 'DRY RUN' : 'APPLY'

const promoteAll = JSON.parse(readFileSync('/tmp/promote-list.json', 'utf8')).promote
const resolvedAll = JSON.parse(readFileSync('/tmp/resolved.json', 'utf8')).resolved
const freetextAll = JSON.parse(readFileSync('/tmp/freetext-geocoded.json', 'utf8'))

// --limit caps each phase independently (useful for sanity smokes).
const promote = LIMIT ? promoteAll.slice(0, LIMIT) : promoteAll
const resolved = LIMIT ? resolvedAll.slice(0, LIMIT) : resolvedAll
const freetext = LIMIT ? freetextAll.slice(0, Math.min(LIMIT, freetextAll.length)) : freetextAll

console.error(`[migrate-refs] workspace=${workspaceId} profile=${PROFILE} mode=${mode}`)
console.error(`[migrate-refs] promote: ${promote.length} target pages`)
console.error(`[migrate-refs] resolved: ${resolved.length} location-ref writes`)
console.error(`[migrate-refs] freetext: ${freetext.length} (Seattle/Fairfield/Stanford-clinic)`)

if (DRY) {
  console.error('[migrate-refs] DRY RUN — exiting before mutations')
  process.exit(0)
}

// Pre-cache wikilink-target → page id mapping via alias index so the apply
// script can write location refs without a per-row alias query.
const targetsNeeded = [...new Set(promote.map(p => p.target))]
const ALIAS_LOOKUP_SCRIPT = `
const TARGETS = ${JSON.stringify(targetsNeeded)}
const placeholders = TARGETS.map(() => '?').join(',')
const rows = await db.getAll(
  \`SELECT id, properties_json FROM blocks
    WHERE EXISTS (SELECT 1 FROM json_each(properties_json, '$.alias') WHERE value IN (\${placeholders}))\`,
  TARGETS
)
const map = {}
for (const r of rows) {
  const p = JSON.parse(r.properties_json)
  for (const a of (p.alias || [])) if (TARGETS.includes(a) && !map[a]) map[a] = r.id
}
return JSON.stringify(map)
`
const aliasLookupTmp = `/tmp/migrate-refs-alias-lookup-${process.pid}.js`
writeFileSync(aliasLookupTmp, ALIAS_LOOKUP_SCRIPT)
const aliasMapJsonRaw = JSON.parse(kmagent('eval', '--file', aliasLookupTmp, '--raw'))
const aliasMap = JSON.parse(aliasMapJsonRaw)
console.error(`[migrate-refs] alias lookup: ${Object.keys(aliasMap).length}/${targetsNeeded.length} targets found`)
if (Object.keys(aliasMap).length < targetsNeeded.length) {
  const missing = targetsNeeded.filter(t => !aliasMap[t])
  console.error(`[migrate-refs] WARN missing alias pages: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`)
}

// ─── Phase 1: Promote pages to Place blocks ──────────────────────────

const promotionsManifest = promote
  .map(p => ({
    pageId: aliasMap[p.target],
    target: p.target,
    placeData: p.placeData,
  }))
  .filter(p => p.pageId) // skip targets whose page disappeared

const PROMOTE_SCRIPT = `
const PROMOS = ${JSON.stringify(promotionsManifest)}
const props = await import('/src/plugins/geo/properties.ts')
const types = await import('/src/plugins/geo/blockTypes.ts')
const coreProps = await import('/src/data/properties.ts')
const api = await import('/src/data/api/index.ts')

const {PLACE_TYPE} = types
const {ChangeScope} = api
const {aliasesProp} = coreProps

const result = {ok: 0, skipped: 0, fail: 0, errors: []}

for (const p of PROMOS) {
  try {
    const live = await repo.load(p.pageId)
    if (!live) { result.fail++; result.errors.push({target: p.target, why: 'not found'}); continue }
    const existingTypes = Array.isArray(live.properties.types) ? live.properties.types : []
    if (existingTypes.includes(PLACE_TYPE)) { result.skipped++; continue }

    const existingAliases = Array.isArray(live.properties[aliasesProp.name])
      ? live.properties[aliasesProp.name] : []
    const machineAlias = p.placeData.placeId ? 'place:' + p.placeData.placeId : null
    const nextAliases = (machineAlias && !existingAliases.includes(machineAlias))
      ? [...existingAliases, machineAlias]
      : existingAliases
    const typeSnapshot = repo.snapshotTypeRegistries()

    await repo.tx(async tx => {
      if (nextAliases !== existingAliases) {
        await tx.setProperty(p.pageId, aliasesProp, nextAliases)
      }
      await repo.addTypeInTx(tx, p.pageId, PLACE_TYPE, {[aliasesProp.name]: nextAliases}, typeSnapshot)
      await tx.setProperty(p.pageId, props.placeLatProp, p.placeData.lat)
      await tx.setProperty(p.pageId, props.placeLngProp, p.placeData.lng)
      if (p.placeData.address) await tx.setProperty(p.pageId, props.placeAddressProp, p.placeData.address)
      if (p.placeData.placeId) await tx.setProperty(p.pageId, props.placeGooglePlaceIdProp, p.placeData.placeId)
    }, {scope: ChangeScope.BlockDefault, description: 'promote roam page to place'})
    result.ok++
  } catch (err) {
    result.fail++
    result.errors.push({target: p.target, why: String(err?.message ?? err)})
  }
}
return JSON.stringify(result)
`

const promoteTmp = `/tmp/migrate-refs-promote-${process.pid}.js`
writeFileSync(promoteTmp, PROMOTE_SCRIPT)
console.error(`[migrate-refs] Phase 1: promoting ${promotionsManifest.length} pages…`)
const promoteRaw = JSON.parse(kmagent('eval', '--file', promoteTmp, '--raw'))
const promoteResult = JSON.parse(promoteRaw)
console.error(`[migrate-refs] Phase 1 done: ok=${promoteResult.ok} skipped=${promoteResult.skipped} fail=${promoteResult.fail}`)
if (promoteResult.errors.length) console.error(`[migrate-refs] Phase 1 errors:`, promoteResult.errors.slice(0, 10))

// ─── Phase 2: Write location refs on resolved rows ────────────────────

// Chunk the writes to keep each eval under the 30s default timeout.
const CHUNK = 200
const refWrites = resolved.map(r => ({blockId: r.blockId, locationPageId: r.chosen.pageBlockId}))

const REFS_SCRIPT_TEMPLATE = `
const WRITES = __WRITES__
const props = await import('/src/plugins/geo/properties.ts')
const api = await import('/src/data/api/index.ts')
const {ChangeScope} = api
const result = {ok: 0, fail: 0, errors: []}
for (const w of WRITES) {
  try {
    await repo.tx(async tx => {
      await tx.setProperty(w.blockId, props.locationProp, w.locationPageId)
    }, {scope: ChangeScope.BlockDefault, description: 'migrate roam:location ref'})
    result.ok++
  } catch (err) {
    result.fail++
    result.errors.push({blockId: w.blockId, why: String(err?.message ?? err)})
  }
}
return JSON.stringify(result)
`

let refsOk = 0, refsFail = 0
const refsErrors = []
for (let start = 0; start < refWrites.length; start += CHUNK) {
  const chunk = refWrites.slice(start, start + CHUNK)
  const script = REFS_SCRIPT_TEMPLATE.replace('__WRITES__', JSON.stringify(chunk))
  const tmp = `/tmp/migrate-refs-chunk-${process.pid}-${start}.js`
  writeFileSync(tmp, script)
  const raw = JSON.parse(kmagent('eval', '--file', tmp, '--raw'))
  const r = JSON.parse(raw)
  refsOk += r.ok; refsFail += r.fail; refsErrors.push(...r.errors)
  console.error(`[migrate-refs] Phase 2 chunk ${start}..${start + chunk.length}: ok=${r.ok} fail=${r.fail}`)
}
console.error(`[migrate-refs] Phase 2 done: ok=${refsOk} fail=${refsFail}`)
if (refsErrors.length) console.error(`[migrate-refs] Phase 2 errors:`, refsErrors.slice(0, 10))

// ─── Phase 3: Free-text migrations (Seattle / Fairfield / Stanford clinic) ──

const FREETEXT_SCRIPT = `
const FT = ${JSON.stringify(freetext)}
const props = await import('/src/plugins/geo/properties.ts')
const types = await import('/src/plugins/geo/blockTypes.ts')
const coreProps = await import('/src/data/properties.ts')
const api = await import('/src/data/api/index.ts')
const cof = await import('/src/plugins/geo/createOrFindPlace.ts')

const {ChangeScope} = api
const ws = ${JSON.stringify(workspaceId)}

const result = {ok: 0, fail: 0, errors: []}

for (const entry of FT) {
  try {
    // Use createOrFindPlace — dedups against existing Place via the
    // place:<placeId> alias (Seattle/Fairfield already promoted in Phase 1
    // would be found by alias lookup; Stanford clinic is a fresh POI).
    const handle = await cof.createOrFindPlace(repo, ws, {
      name: entry.top.name,
      lat: entry.top.lat,
      lng: entry.top.lng,
      address: entry.top.address,
      googlePlaceId: entry.top.placeId,
    })
    await repo.tx(async tx => {
      await tx.setProperty(entry.sourceBlock, props.locationProp, handle.id)
    }, {scope: ChangeScope.BlockDefault, description: 'migrate roam:location free-text'})
    result.ok++
  } catch (err) {
    result.fail++
    result.errors.push({sourceBlock: entry.sourceBlock, target: entry.target, why: String(err?.message ?? err)})
  }
}
return JSON.stringify(result)
`

const ftTmp = `/tmp/migrate-refs-freetext-${process.pid}.js`
writeFileSync(ftTmp, FREETEXT_SCRIPT)
console.error(`[migrate-refs] Phase 3: migrating ${freetext.length} free-text rows…`)
const ftRaw = JSON.parse(kmagent('eval', '--file', ftTmp, '--raw'))
const ftResult = JSON.parse(ftRaw)
console.error(`[migrate-refs] Phase 3 done: ok=${ftResult.ok} fail=${ftResult.fail}`)
if (ftResult.errors.length) console.error(`[migrate-refs] Phase 3 errors:`, ftResult.errors)

console.error('[migrate-refs] complete.')
