#!/usr/bin/env node
/**
 * Dependency report — `node scripts/deps-report.mjs [--cwd <dir>]`.
 *
 * Prints, as markdown, what a dependency refresh can take TODAY under the
 * project's release cooldown (`minimumReleaseAge` in pnpm-workspace.yaml):
 * per-project bump commands for the newest eligible version inside each
 * package's major, the newest eligible next major, what the cooldown still
 * holds back (with the date it clears), the pinned pnpm, and GitHub Actions
 * refs behind their latest major.
 *
 * The inventory is the lockfile (`pnpm ls --lockfile-only`), not `pnpm
 * outdated`: outdated already applies the cooldown, so a package whose only
 * newer releases are still inside it would vanish instead of showing as held.
 * Eligibility comes from each package's registry document. It changes nothing;
 * the deps-refresh skill (.claude/skills/deps-refresh) says what to do with
 * the report.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { isMainModule } from './is-main-module.mjs'

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/

/** A version's caret line: `x` for x >= 1, `0.y` below 1, `0.0.z` below that. */
const lineOf = version => {
  const [, major, minor, patch] = STABLE.exec(version)
  if (major !== '0') return major
  return minor !== '0' ? `0.${minor}` : `0.0.${patch}`
}

const compareVersions = (a, b) => {
  const pa = STABLE.exec(a).slice(1).map(Number)
  const pb = STABLE.exec(b).slice(1).map(Number)
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

/**
 * `packument` is the registry document: `time` (version -> publish date) and
 * `versions` (the published manifests). Only published, non-deprecated stable
 * versions are targets: `time` keeps unpublished versions, and pnpm itself
 * steers around deprecated ones, which an explicit `name@version` overrides.
 */
export const classifyPackage = ({name, current}, {time = {}, versions = {}}, {now, cooldownMs}) => {
  const row = {name, current, prerelease: !STABLE.test(current), sameMajor: null, major: null, held: null}
  if (row.prerelease) return row
  const newer = Object.keys(versions)
    .filter(v => STABLE.test(v) && !versions[v].deprecated && time[v] && compareVersions(v, current) > 0)
    .map(version => ({version, published: time[version], eligibleAt: new Date(Date.parse(time[version]) + cooldownMs).toISOString()}))
    .sort((a, b) => compareVersions(a.version, b.version))
  const eligible = newer.filter(v => Date.parse(v.eligibleAt) <= now)
  const line = lineOf(current)
  // Everything in `newer` is above `current`, so any other line is a higher one.
  row.sameMajor = eligible.findLast(v => lineOf(v.version) === line) ?? null
  row.major = eligible.findLast(v => lineOf(v.version) !== line) ?? null
  const newest = newer.at(-1)
  row.held = newest && !eligible.includes(newest) ? newest : null
  return row
}

const isAliased = row => row.from !== row.name

/**
 * The bumps that are safe to apply mechanically. One command per project:
 * `pnpm up -r pkg@x` applies x to every project that has pkg, so a package on
 * different majors in different projects would drag one across. Each target
 * is named with its version, which keeps each specifier's pin style and is the
 * only way to move an exact pin. Aliases and the pinned pnpm are left out:
 * `pnpm up name@version` would rewrite an `npm:` specifier, and pnpm isn't a
 * dependency. The final `up -r` refreshes everything else in range,
 * transitive dependencies included.
 */
export const refreshCommands = (rows, label = '.') => {
  const pnpm = label === '.' ? 'pnpm' : `pnpm -C ${label}`
  const targetsByProject = new Map()
  for (const row of rows) {
    if (!row.sameMajor || row.packageManager || isAliased(row)) continue
    for (const project of row.users) {
      if (!targetsByProject.has(project)) targetsByProject.set(project, [])
      targetsByProject.get(project).push(`${row.name}@${row.sameMajor.version}`)
    }
  }
  const perProject = [...targetsByProject].map(([project, targets]) => `${pnpm} --filter ${project} up ${targets.join(' ')}`)
  return [...perProject, `${pnpm} up -r`]
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

/** A missing setting throws: the report must never treat every release as
 *  eligible because a project forgot its cooldown. */
const readCooldownMinutes = (dir, label) => {
  const file = join(dir, 'pnpm-workspace.yaml')
  const match = existsSync(file) && /^minimumReleaseAge:\s*(\d+)/m.exec(readFileSync(file, 'utf8'))
  if (!match) throw new Error(`${label}/pnpm-workspace.yaml sets no minimumReleaseAge: refusing to guess a cooldown`)
  return Number(match[1])
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

/**
 * `result` is spawnSync's for `pnpm ls -r --depth 0 --json --lockfile-only`:
 * every project's direct dependencies as the lockfile pins them, installed or
 * not. Anything but a clean listing throws, so a failed scan can never read as
 * "nothing to update". Workspace links and other non-registry versions are
 * not this report's concern and are skipped.
 */
export const readInventory = ({status, stdout, stderr, error}) => {
  if (error) throw new Error(`pnpm ls did not run: ${error.message}`)
  const detail = `(exit ${status}): ${(stderr ?? '').trim().slice(0, 500)}`
  if (status !== 0) throw new Error(`pnpm ls failed ${detail}`)
  let projects
  try {
    projects = JSON.parse(stdout)
  } catch {
    projects = null
  }
  if (!Array.isArray(projects)) throw new Error(`pnpm ls printed no project list ${detail}`)
  const rows = new Map()
  for (const project of projects) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, dep] of Object.entries(project[field] ?? {})) {
        if (!/^\d/.test(dep.version)) continue
        const key = `${name}@${dep.version}`
        const row = rows.get(key) ?? {name, from: dep.from ?? name, current: dep.version, users: new Set()}
        row.users.add(project.name)
        rows.set(key, row)
      }
    }
  }
  return [...rows.values()].map(({users, ...row}) => ({...row, users: [...users]}))
}

/** The registry document, reduced to what classifyPackage reads; null when
 *  npmjs doesn't have it (a private scope). */
const fetchPackument = async name => {
  let response
  try {
    response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)
  } catch (error) {
    throw new Error(`registry fetch for ${name} failed: ${error.message}`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`registry ${response.status} for ${name}`)
  const {time = {}, versions = {}} = await response.json()
  const deprecation = Object.fromEntries(Object.entries(versions).map(([v, m]) => [v, {deprecated: m.deprecated}]))
  return {time, versions: deprecation}
}

/** Cached per name: an alias shares its package's document. */
const packuments = new Map()
const registryPackument = name => {
  if (!packuments.has(name)) packuments.set(name, fetchPackument(name))
  return packuments.get(name)
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

/** `{tag, major, published}`, or `{error}` saying why the latest release is unreadable. */
const latestActionRelease = async action => {
  const headers = process.env.GITHUB_TOKEN ? {authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {}
  let response
  try {
    response = await fetch(`https://api.github.com/repos/${action}/releases/latest`, {headers})
  } catch (error) {
    return {error: error.message}
  }
  if (!response.ok) return {error: `HTTP ${response.status}`}
  const {tag_name: tag, published_at: published} = await response.json()
  const major = actionRefMajor(tag ?? '')
  return major === null ? {error: `tag ${tag}`} : {tag, major, published}
}

const day = iso => (iso ?? '').slice(0, 10)

const render = ({label, cooldownMinutes, rows, actions}) => {
  const lines = [`# Dependency report: ${label}`, '', `Cooldown: ${cooldownMinutes} minutes (${(cooldownMinutes / 1440).toFixed(1)} days).`, '']
  const table = (title, filtered, columns) => {
    if (!filtered.length) return
    lines.push(`## ${title}`, '', `| ${columns.map(c => c[0]).join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`)
    for (const row of filtered) lines.push(`| ${columns.map(c => c[1](row)).join(' | ')} |`)
    lines.push('')
  }
  const shown = r => isAliased(r) ? `${r.name} (npm:${r.from})` : r.name
  const usedBy = r => r.users.join(', ')
  table('Same-major updates', rows.filter(r => r.sameMajor), [
    ['package', shown], ['current', r => r.current], ['target', r => r.sameMajor.version], ['used by', usedBy],
  ])
  lines.push('Apply with:', '', '```bash', ...refreshCommands(rows, label), '```', '')
  const pm = rows.find(r => r.packageManager && r.sameMajor)
  if (pm) lines.push(`Set \`"packageManager": "pnpm@${pm.sameMajor.version}"\` in package.json.`, '')
  for (const r of rows.filter(r => r.sameMajor && isAliased(r))) {
    lines.push(`Aliased, so bump its specifier by hand: \`${r.name}\` to \`npm:${r.from}@${r.sameMajor.version}\`, keeping its range prefix.`, '')
  }
  table('Eligible majors (research before taking)', rows.filter(r => r.major), [
    ['package', shown], ['current', r => r.current], ['major', r => r.major.version], ['published', r => day(r.major.published)], ['used by', usedBy],
  ])
  table('Held by the cooldown', rows.filter(r => r.held), [
    ['package', shown], ['newest', r => r.held.version], ['published', r => day(r.held.published)], ['eligible from', r => r.held.eligibleAt.slice(0, 16)],
  ])
  table('Check by hand', rows.filter(r => r.prerelease || r.notOnNpm), [
    ['package', shown], ['current', r => r.current], ['why', r => r.notOnNpm ? 'not on npmjs' : 'prerelease'],
  ])
  table('GitHub Actions behind their latest major', actions.filter(a => a.major !== null && a.latest.major > a.major), [
    ['action', a => a.action], ['used', a => a.ref], ['latest', a => a.latest.tag], ['released', a => day(a.latest.published)],
  ])
  const bySha = actions.filter(a => a.major === null)
  if (bySha.length) lines.push(`Actions pinned to a SHA or branch (check by hand): ${bySha.map(a => `${a.action}@${a.ref.slice(0, 12)}`).join(', ')}`, '')
  const unknown = actions.filter(a => a.major !== null && a.latest.error)
  if (unknown.length) {
    const rateLimited = unknown.some(a => a.latest.error === 'HTTP 403' || a.latest.error === 'HTTP 429')
    lines.push(`Actions whose latest release could not be read: ${unknown.map(a => `${a.action} (${a.latest.error})`).join(', ')}`, '')
    if (rateLimited) lines.push('GitHub allows 60 unauthenticated API requests an hour; a GITHUB_TOKEN already in the environment raises that.', '')
  }
  return lines.join('\n')
}

const main = async argv => {
  const cwdFlag = argv.indexOf('--cwd')
  const dir = resolve(cwdFlag >= 0 ? argv[cwdFlag + 1] : '.')
  // Relative, so the header and commands never carry a local absolute path.
  const label = relative(process.cwd(), dir) || '.'
  const cooldownMinutes = readCooldownMinutes(dir, label)
  const policy = {now: Date.now(), cooldownMs: cooldownMinutes * 60_000}

  const inventory = readInventory(spawnSync('pnpm', ['ls', '-r', '--depth', '0', '--json', '--lockfile-only'], {cwd: dir, encoding: 'utf8'}))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const pinnedPnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(manifest.packageManager ?? '')
  if (pinnedPnpm) inventory.push({name: 'pnpm', from: 'pnpm', current: pinnedPnpm[1], users: ['packageManager'], packageManager: true})
  const rows = await mapLimit(inventory, 8, async pkg => {
    const doc = await registryPackument(pkg.from)
    return doc ? {...pkg, ...classifyPackage(pkg, doc, policy)} : {...pkg, notOnNpm: true}
  })

  const workflowDir = join(dir, '.github', 'workflows')
  const uses = existsSync(workflowDir)
    ? readdirSync(workflowDir).filter(f => /\.ya?ml$/.test(f)).flatMap(f => parseWorkflowUses(readFileSync(join(workflowDir, f), 'utf8')))
    : []
  const distinct = [...new Map(uses.map(u => [`${u.action}@${u.ref}`, u])).values()]
  const actions = await mapLimit(distinct, 4, async u => {
    const major = actionRefMajor(u.ref)
    return {...u, major, latest: major === null ? null : await latestActionRelease(u.action)}
  })

  console.log(render({label, cooldownMinutes, rows, actions}))
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
