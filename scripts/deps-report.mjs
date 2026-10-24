#!/usr/bin/env node
/**
 * Dependency report — `node scripts/deps-report.mjs [--cwd <dir>]`.
 *
 * Prints, as markdown, what a dependency refresh could take TODAY under the
 * project's release cooldown (`minimumReleaseAge` in pnpm-workspace.yaml):
 * the newest eligible version inside each package's current major, the newest
 * eligible next major, and what the cooldown still holds back (with the date
 * it clears). Also the pinned pnpm (`packageManager`), version-pinned esm.sh
 * URL imports, and GitHub Actions refs behind their latest major.
 *
 * `pnpm outdated` reports the registry's `latest` tag, which ignores the
 * cooldown, so eligibility comes from each package's publish times instead.
 * It changes nothing; the deps-refresh skill (.claude/skills/deps-refresh)
 * says what to do with the report.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isMainModule } from './is-main-module.mjs'

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

/** A version's major LINE: `x` for x >= 1, `0.y` below 1 (caret semantics). */
const lineOf = version => {
  const [, major, minor] = STABLE.exec(version)
  return major === '0' ? `0.${minor}` : major
}

const compareLines = (a, b) => {
  const [aMajor, aMinor = 0] = a.split('.').map(Number)
  const [bMajor, bMinor = 0] = b.split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor
}

const compareVersions = (a, b) => {
  const pa = STABLE.exec(a).slice(1).map(Number)
  const pb = STABLE.exec(b).slice(1).map(Number)
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

/**
 * `times` is the registry's `time` map (version -> ISO publish date, plus
 * `created`/`modified`). Prereleases never count as targets.
 */
export const classifyPackage = ({name, current}, times, {now, cooldownMs}) => {
  const row = {name, current, prerelease: !STABLE.test(current), sameMajor: null, major: null, held: null}
  if (row.prerelease) return row
  const newer = Object.entries(times)
    .filter(([version]) => STABLE.test(version) && compareVersions(version, current) > 0)
    .map(([version, published]) => ({version, published, eligibleAt: new Date(Date.parse(published) + cooldownMs).toISOString()}))
    .sort((a, b) => compareVersions(a.version, b.version))
  const eligible = newer.filter(v => Date.parse(v.eligibleAt) <= now)
  const line = lineOf(current)
  row.sameMajor = eligible.filter(v => lineOf(v.version) === line).at(-1) ?? null
  row.major = eligible.filter(v => compareLines(lineOf(v.version), line) > 0).at(-1) ?? null
  const newest = newer.at(-1)
  const best = row.major ?? row.sameMajor
  if (newest && (!best || compareVersions(newest.version, best.version) > 0)) row.held = newest
  return row
}

/**
 * The bump that is safe to apply mechanically. Every target is named with its
 * version: `pnpm up -r name@version` keeps each specifier's pin style (exact
 * stays exact, `^` stays `^`), and a bare `pnpm up -r` cannot move an exact
 * pin at all. `--latest` would also cross into a held major.
 */
export const sameMajorUpCommand = rows => {
  const targets = rows.filter(r => r.sameMajor && !r.packageManager).map(r => `${r.name}@${r.sameMajor.version}`)
  return targets.length ? `pnpm up -r ${targets.join(' ')}` : null
}

export const parseWorkflowUses = text =>
  [...text.matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*['"]?([^'"\s#]+)['"]?/gm)]
    .map(m => m[1])
    .filter(spec => !spec.startsWith('./') && !spec.startsWith('docker://') && spec.includes('@'))
    .map(spec => {
      const [path, ref] = spec.split('@')
      return {action: path.split('/').slice(0, 2).join('/'), ref}
    })

/** A tag's major (`v4`, `v4.1.0`, `6`); null for a commit SHA or a branch. */
export const actionRefMajor = ref => {
  const match = /^v?(\d+)(?:\.\d+)*$/.exec(ref)
  return match ? Number(match[1]) : null
}

export const parseEsmShPins = text =>
  [...text.matchAll(/https:\/\/esm\.sh\/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+)/g)].map(m => ({name: m[1], version: m[2]}))

/** null when the project sets none (pnpm's own default then applies). */
const readCooldownMinutes = dir => {
  const file = join(dir, 'pnpm-workspace.yaml')
  const match = existsSync(file) && /^minimumReleaseAge:\s*(\d+)/m.exec(readFileSync(file, 'utf8'))
  return match ? Number(match[1]) : null
}

/**
 * `result` is spawnSync's for `pnpm outdated -r --format json`, which exits 1
 * when something is outdated. Anything that is not a clean scan throws, so a
 * failed scan can never read as "nothing to update". Before the first install
 * pnpm prints no `current`, only the lockfile's `wanted`.
 */
export const readOutdated = ({status, stdout, stderr, error}) => {
  if (error) throw new Error(`pnpm outdated did not run: ${error.message}`)
  const detail = `(exit ${status}): ${(stderr ?? '').trim().slice(0, 500)}`
  if (status !== 0 && status !== 1) throw new Error(`pnpm outdated failed ${detail}`)
  if (!stdout.trim()) {
    if (status === 0) return []
    throw new Error(`pnpm outdated printed no JSON ${detail}`)
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`pnpm outdated printed no JSON ${detail}`)
  }
  return Object.entries(parsed).map(([name, info]) => ({
    name,
    current: info.current ?? info.wanted ?? null,
    usedBy: (info.dependentPackages ?? []).map(d => d.name).join(', '),
  }))
}

/** null when npmjs doesn't have it (a private scope, a typo'd URL import). */
const registryTimes = async name => {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`registry ${response.status} for ${name}`)
  return (await response.json()).time ?? {}
}

const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

const latestActionMajor = async action => {
  const headers = process.env.GITHUB_TOKEN ? {authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {}
  const response = await fetch(`https://api.github.com/repos/${action}/releases/latest`, {headers})
  if (!response.ok) return null
  const {tag_name: tag} = await response.json()
  const major = /^v?(\d+)/.exec(tag ?? '')?.[1]
  return major ? {tag, major: Number(major)} : null
}

const trackedFiles = (dir, pattern) => {
  // Tests and docs hold example URLs, not dependencies.
  const exclude = [':!pnpm-lock.yaml', ':!.beads', ':!docs', ':!*.test.*', ':!**/test/**']
  const result = spawnSync('git', ['grep', '-l', '-E', pattern, '--', ...exclude], {cwd: dir, encoding: 'utf8'})
  return result.stdout.split('\n').filter(Boolean).map(file => join(dir, file))
}

const day = iso => iso.slice(0, 10)

const render = ({label, cooldownMinutes, rows, actions, esmPins}) => {
  const cooldown = cooldownMinutes === null
    ? 'NONE set in pnpm-workspace.yaml: every newer version below counts as eligible.'
    : `${cooldownMinutes} minutes (${(cooldownMinutes / 1440).toFixed(1)} days).`
  const lines = [`# Dependency report: ${label}`, '', `Cooldown: ${cooldown}`, '']
  const table = (title, filtered, columns) => {
    if (!filtered.length) return
    lines.push(`## ${title}`, '', `| ${columns.map(c => c[0]).join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`)
    for (const row of filtered) lines.push(`| ${columns.map(c => c[1](row)).join(' | ')} |`)
    lines.push('')
  }
  table('Same-major updates', rows.filter(r => r.sameMajor), [
    ['package', r => r.name], ['current', r => r.current], ['target', r => r.sameMajor.version], ['used by', r => r.usedBy],
  ])
  const command = sameMajorUpCommand(rows)
  if (command) lines.push('Apply with:', '', '```bash', command, 'pnpm up -r', '```', '')
  const pm = rows.find(r => r.packageManager && r.sameMajor)
  if (pm) lines.push(`Set \`"packageManager": "pnpm@${pm.sameMajor.version}"\` in package.json.`, '')
  table('Eligible majors (research before taking)', rows.filter(r => r.major), [
    ['package', r => r.name], ['current', r => r.current], ['major', r => r.major.version], ['published', r => day(r.major.published)], ['used by', r => r.usedBy],
  ])
  table('Held by the cooldown', rows.filter(r => r.held), [
    ['package', r => r.name], ['newest', r => r.held.version], ['published', r => day(r.held.published)], ['eligible from', r => r.held.eligibleAt.slice(0, 16)],
  ])
  const whyByHand = r => r.noVersion ? 'no installed or locked version' : r.notOnNpm ? 'not on npmjs' : 'prerelease'
  table('Check by hand', rows.filter(r => r.prerelease || r.notOnNpm || r.noVersion), [
    ['package', r => r.name], ['current', r => r.current ?? '?'], ['why', whyByHand],
  ])
  table('esm.sh URL pins', esmPins, [
    ['package', r => r.name], ['pinned', r => r.version], ['newest eligible', r => r.target ?? 'current'], ['files', r => r.files.join(', ')],
  ])
  table('GitHub Actions behind their latest major', actions.filter(a => a.major !== null && a.latest && a.latest.major > a.major), [
    ['action', a => a.action], ['used', a => a.ref], ['latest', a => a.latest.tag],
  ])
  const bySha = actions.filter(a => a.major === null)
  if (bySha.length) lines.push(`Actions pinned to a SHA or branch (check by hand): ${bySha.map(a => `${a.action}@${a.ref.slice(0, 12)}`).join(', ')}`, '')
  const unknown = actions.filter(a => a.major !== null && !a.latest)
  if (unknown.length) lines.push(`Actions with no readable latest release: ${unknown.map(a => a.action).join(', ')}`, '')
  return lines.join('\n')
}

const main = async argv => {
  const cwdFlag = argv.indexOf('--cwd')
  const label = cwdFlag >= 0 ? argv[cwdFlag + 1] : '.'
  const dir = resolve(label)
  const cooldownMinutes = readCooldownMinutes(dir)
  const policy = {now: Date.now(), cooldownMs: (cooldownMinutes ?? 0) * 60_000}

  const outdated = readOutdated(spawnSync('pnpm', ['outdated', '-r', '--format', 'json'], {cwd: dir, encoding: 'utf8'}))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const pinnedPnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(manifest.packageManager ?? '')
  if (pinnedPnpm) outdated.push({name: 'pnpm', current: pinnedPnpm[1], usedBy: 'packageManager', packageManager: true})
  const rows = (await mapLimit(outdated, 8, async pkg => {
    if (pkg.current === null) return {...pkg, noVersion: true}
    const times = await registryTimes(pkg.name)
    return times ? {...classifyPackage(pkg, times, policy), usedBy: pkg.usedBy, packageManager: pkg.packageManager} : {...pkg, notOnNpm: true}
  })).filter(r => r.sameMajor || r.major || r.held || r.prerelease || r.notOnNpm || r.noVersion)

  const pinsByName = new Map()
  for (const file of trackedFiles(dir, 'https://esm\\.sh/')) {
    for (const pin of parseEsmShPins(readFileSync(file, 'utf8'))) {
      const key = `${pin.name}@${pin.version}`
      const entry = pinsByName.get(key) ?? {...pin, files: []}
      const relative = file.slice(dir.length + 1)
      if (!entry.files.includes(relative)) entry.files.push(relative)
      pinsByName.set(key, entry)
    }
  }
  const esmPins = await mapLimit([...pinsByName.values()], 8, async pin => {
    const times = await registryTimes(pin.name)
    if (!times) return {...pin, target: 'not on npm'}
    const row = classifyPackage({name: pin.name, current: pin.version}, times, policy)
    return {...pin, target: (row.major ?? row.sameMajor)?.version}
  })

  const workflowDir = join(dir, '.github', 'workflows')
  const uses = existsSync(workflowDir)
    ? readdirSync(workflowDir).filter(f => /\.ya?ml$/.test(f)).flatMap(f => parseWorkflowUses(readFileSync(join(workflowDir, f), 'utf8')))
    : []
  const distinct = [...new Map(uses.map(u => [`${u.action}@${u.ref}`, u])).values()]
  const actions = await mapLimit(distinct, 4, async u => ({...u, major: actionRefMajor(u.ref), latest: await latestActionMajor(u.action)}))

  console.log(render({label, cooldownMinutes, rows, actions, esmPins}))
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
