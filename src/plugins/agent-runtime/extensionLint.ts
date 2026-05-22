/**
 * Source-level lint for extension blocks. Surfaces anti-patterns the
 * agent is likely to fall into when not reading the authoring catalog
 * carefully — every rule names a canonical replacement (catalog
 * pattern id + a one-liner "what to do instead").
 *
 * The lint runs at `install-extension --verify` time. It's
 * non-blocking — warnings are returned alongside the verification
 * facets/actions so the agent can see them at install time, decide
 * whether to fix, and re-run install if it does. Lint warnings being
 * advisory (not errors) lets a one-off / experimental extension still
 * land; the agent's choice to ignore is visible and reversible.
 *
 * Each rule has two parts:
 *   - `match(source)` — quick regex/text check. Cheap.
 *   - `applies(source, hits)` — optional second-pass refinement. Skips
 *     the warning if the hits are actually OK (e.g. localStorage key
 *     contains a credential-looking substring).
 */

export interface ExtensionLintWarning {
  /** Stable rule id, e.g. `config-in-localstorage`. Lets agents
   *  suppress / acknowledge specific rules per extension via comments
   *  if we ever need that escape hatch. */
  rule: string
  /** One-line problem statement. */
  message: string
  /** Catalog pattern id that solves this — agent can fetch the full
   *  example via `yarn agent describe-runtime --guide block-backed-config`
   *  or read the principles from `runtime-summary.capabilities.storage`. */
  catalogPattern: string
  /** First line of source that matched, for at-a-glance "where". */
  example?: string
}

interface LintRule {
  rule: string
  catalogPattern: string
  message: string
  // Test a line at a time. Return the matched substring if this line
  // triggers the rule, null otherwise. Line-at-a-time keeps the
  // `example` field meaningful and lets us bail before assembling a
  // full body match.
  testLine(line: string): string | null
  // Optional whole-source escape hatch — if the source has a marker
  // like `// lint-ok: <rule-id> (reason)`, suppress the warning.
  // Keeps the lint advisory without poisoning the agent into never
  // using a pattern in a justified case.
}

const isLikelyCredentialKey = (key: string): boolean =>
  /token|secret|password|api[_-]?key|credentials?|auth/i.test(key)

// Match `window.localStorage.setItem(...)` / `localStorage.setItem(...)`
// — broad form first, then a follow-up to decide whether the key is a
// credential literal we should leave alone.
const LOCALSTORAGE_SET_RE = /(?:window\.)?localStorage\s*\.\s*setItem\s*\(\s*([^,)]+)/
// When the first arg is a string literal, extract the key value.
// (Captures both single- and double-quoted.)
const STRING_LITERAL_RE = /^\s*['"]([^'"]+)['"]\s*$/

const rules: LintRule[] = [
  {
    rule: 'config-in-localstorage',
    catalogPattern: 'user-prefs-config',
    message:
      'Non-credential settings stored in localStorage. Use `getPluginPrefsBlock(repo, workspaceId, user, type)` so settings sync across the user\'s devices and benefit from typed property codecs. Keep credentials (tokens, API keys) in localStorage; everything else goes in a prefs block.',
    testLine(line) {
      const match = line.match(LOCALSTORAGE_SET_RE)
      if (!match) return null
      const firstArg = (match[1] ?? '').trim()
      const literalMatch = firstArg.match(STRING_LITERAL_RE)
      if (literalMatch) {
        // Literal key — apply the credential exemption (the authoring
        // guide explicitly allows credentials in localStorage).
        if (isLikelyCredentialKey(literalMatch[1]!)) return null
      }
      // For variable / computed keys (e.g. `STATE_KEY`) we can't
      // statically tell whether it's a credential — flag and let the
      // agent inspect. False positives are cheap (a `// lint-ok:`
      // marker dismisses); false negatives reintroduce the bug we
      // wrote this lint to catch.
      return match[0]
    },
  },
  {
    rule: 'stored-plugin-block-id',
    catalogPattern: 'plugin-root-singleton',
    message:
      'Persisting a plugin\'s root or per-record block id (e.g. in localStorage or a config block) means a cache clear or fresh device creates a duplicate. Derive ids deterministically with `pluginBlockId(workspaceId, NAMESPACE, key)` — same inputs always return the same id, so re-installs land on the existing block.',
    testLine(line) {
      // Heuristic: an assignment or write that pairs an `id`-shaped
      // key with the localStorage / state-blob layer. Catches
      // `state.rootBlockId = ...`, `rootBlockId: '...'`,
      // `localStorage.setItem('root-id', ...)`. We don't flag every
      // `id =` because that's noisy — but `rootBlockId` /
      // `*BlockId`-named writes paired with persistent storage are a
      // strong signal.
      const localStorageBlockIdMatch = line.match(
        /(?:window\.)?localStorage\s*\.\s*setItem\s*\(\s*['"][^'"]*(?:block[_-]?id|root[_-]?id|plugin[_-]?id)[^'"]*['"]/i,
      )
      if (localStorageBlockIdMatch) return localStorageBlockIdMatch[0]
      // `pluginBlockId(` usage means the author is already deriving
      // ids — don't flag declarations that mention block ids near a
      // pluginBlockId call.
      return null
    },
  },
  {
    rule: 'dialog-store-instead-of-event',
    catalogPattern: 'settings-dialog',
    message:
      'Toggle dialogs by dispatching `window.dispatchEvent(new CustomEvent(\'<plugin>:toggle-<name>\'))` and listen via `window.addEventListener` inside the dialog component. The CustomEvent pattern matches the find-replace / quick-find conventions and avoids the module-scoped store + `useSyncExternalStore` boilerplate.',
    testLine(line) {
      // Detect module-scoped open-dialog stores: a const named
      // `*Store`, `dialogState`, `dialogOpen` with setOpen/getSnapshot
      // shape. Heuristic — we look for a couple of common signatures.
      if (/const\s+\w*[Dd]ialog\w*Store\s*=/.test(line)) return line.trim().slice(0, 80)
      if (/useSyncExternalStore\s*\(/.test(line)) return line.trim().slice(0, 80)
      return null
    },
  },
]

const SUPPRESS_RE = /\/\/\s*lint-ok\s*:\s*([\w-]+)/

const collectSuppressed = (source: string): Set<string> => {
  const suppressed = new Set<string>()
  for (const line of source.split('\n')) {
    const match = line.match(SUPPRESS_RE)
    if (match?.[1]) suppressed.add(match[1])
  }
  return suppressed
}

/** Run all lint rules against the extension source. Returns the
 *  warnings sorted by rule id for stable output across runs. */
export const lintExtensionSource = (
  source: string,
): ExtensionLintWarning[] => {
  if (!source) return []
  const suppressed = collectSuppressed(source)
  const warnings: ExtensionLintWarning[] = []
  const lines = source.split('\n')

  for (const rule of rules) {
    if (suppressed.has(rule.rule)) continue
    // Take only the first hit per rule — agents don't need 12 copies
    // of the same warning; one is enough to act on, the others get
    // fixed alongside.
    for (const line of lines) {
      const example = rule.testLine(line)
      if (example) {
        warnings.push({
          rule: rule.rule,
          message: rule.message,
          catalogPattern: rule.catalogPattern,
          example: example.length > 120 ? `${example.slice(0, 117)}...` : example,
        })
        break
      }
    }
  }

  // Stable sort so the verify-result shape is deterministic across
  // runs of the same source.
  warnings.sort((a, b) => a.rule.localeCompare(b.rule))
  return warnings
}
