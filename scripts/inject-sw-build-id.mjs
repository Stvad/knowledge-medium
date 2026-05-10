/**
 * Stamps dist/sw.js with a per-build identifier so each deploy lands in
 * its own cache namespace. The previous build's caches are dropped on
 * activate, which closes the stale-vs-fresh skew window that would
 * otherwise be possible with Vite's unhashed `preserveModules` output.
 *
 * Build id sources, in order of preference:
 *   1. SW_BUILD_ID env var (caller can override)
 *   2. GITHUB_SHA   (set by GitHub Actions)
 *   3. `git rev-parse HEAD` (local dev / any checkout)
 *   4. Timestamp + random suffix (last-resort, never deployed)
 *
 * Fails the build if the placeholder isn't present in sw.js — that means
 * the SW source drifted and we'd otherwise ship a SW with a literal
 * `__BUILD_ID__` cache name across all deploys (no invalidation).
 */
import {readFileSync, writeFileSync, existsSync} from 'node:fs'
import {execSync} from 'node:child_process'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const swPath = resolve(__dirname, '..', 'dist', 'sw.js')

if (!existsSync(swPath)) {
  console.error(`[inject-sw-build-id] missing ${swPath} — run vite build first`)
  process.exit(1)
}

const placeholder = '__BUILD_ID__'

const resolveBuildId = () => {
  if (process.env.SW_BUILD_ID) return process.env.SW_BUILD_ID
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12)
  try {
    return execSync('git rev-parse HEAD', {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim()
      .slice(0, 12)
  } catch {
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

const buildId = resolveBuildId()
const source = readFileSync(swPath, 'utf8')

if (!source.includes(placeholder)) {
  console.error(`[inject-sw-build-id] placeholder ${placeholder} not found in sw.js`)
  process.exit(1)
}

const stamped = source.split(placeholder).join(buildId)
writeFileSync(swPath, stamped)
console.log(`[inject-sw-build-id] stamped sw.js with ${buildId}`)
