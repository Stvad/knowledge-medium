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
 * Each rule tests either a line at a time (`testLine` — keeps the
 * `example` field meaningful and bails cheaply) or the whole source
 * (`testSource`), which the data-model rules need: a `seedProperty({…})`
 * declaration spans lines, and the smell is in the *combination* of its
 * `name` and `preset`, never in one line alone.
 *
 * Two kinds of rule live here:
 *   - runtime plumbing (localStorage, stored ids, window events)
 *   - data-model grain (records in a JSON cell, block ids as plain
 *     strings, un-namespaced type ids, re-inventing a core concept)
 *
 * The grain rules are deliberately conservative, because they can only
 * see the *declaration*. Their live-data counterpart is
 * `audit-extension`, which reads the blocks an extension actually wrote
 * and can tell a block id from an external id by looking it up.
 */

export interface ExtensionLintWarning {
  /** Stable rule id, e.g. `config-in-localstorage`. Lets agents
   *  suppress / acknowledge specific rules per extension via comments
   *  if we ever need that escape hatch. */
  rule: string
  /** One-line problem statement. */
  message: string
  /** Catalog pattern id that solves this — agent can fetch the full
   *  example via `pnpm agent describe-runtime --guide block-backed-config`
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
  testLine?(line: string): string | null
  // Test the whole source instead, for rules whose signal spans lines
  // (a multi-line `seedProperty({…})` declaration). Return the excerpt
  // to show as `example`, or null.
  testSource?(source: string): string | null
  // Escape hatch for both kinds: a `// lint-ok: <rule-id> (reason)`
  // marker anywhere in the source suppresses the rule. Keeps the lint
  // advisory without poisoning the agent into never using a pattern in
  // a justified case.
}

// ──── declaration reading (data-model rules) ────

/** Pull out each `fn(` … `)` call body in the source, paren-balanced, so a
 *  rule can reason about a whole `seedProperty({…})` declaration rather than
 *  one line of it. Depth counting is naive about parens inside string
 *  literals; the length cap keeps a mis-parse bounded to one declaration. */
const declarationChunks = (source: string, fn: string): string[] => {
  const chunks: string[] = []
  // A declaration is often generic — `seedProperty<Record<string, Set[]>>({…})`
  // is exactly the shape the JSON-blob rules exist to catch — and may carry
  // whitespace before its parens. Matching only the bare `fn(` text would skip
  // precisely the declarations worth flagging.
  const opener = new RegExp(String.raw`\b${fn}\s*(?:<[^(){}]*>)?\s*\(`, 'g')
  for (;;) {
    const match = opener.exec(source)
    if (!match) break
    const start = match.index
    // Scan from the '(' the match ended on.
    const parenAt = start + match[0].length - 1
    let depth = 0
    let end = parenAt
    const limit = Math.min(source.length, start + 4000)
    for (let i = parenAt; i < limit; i += 1) {
      const ch = source[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    chunks.push(source.slice(start, end + 1))
    // Resume just past this call's name, so a nested declaration inside it
    // (a property list built inline) still gets its own chunk.
    opener.lastIndex = parenAt
  }
  return chunks
}

/** Read a `key: 'value'` string field out of a declaration chunk. */
const stringField = (chunk: string, key: string): string | undefined =>
  new RegExp(String.raw`\b${key}\s*:\s*['"]([^'"]*)['"]`).exec(chunk)?.[1]

/** True when the declaration sets `defaultValue` to an array literal — the
 *  clearest "this cell holds a list" signal, independent of naming. */
const hasArrayDefault = (chunk: string): boolean =>
  /\bdefaultValue\s*:\s*\[/.test(chunk)

/** The part of a property name after its `namespace:` prefix. */
const localName = (name: string): string => name.split(':').at(-1) ?? name

/** Short excerpt naming the offending declaration, for the `example` field. */
const declarationExample = (fn: string, name: string | undefined): string =>
  `${fn}({… name: '${name ?? '?'}' …})`

const JSON_PRESETS = new Set(['json', 'optional-json', 'raw-json'])
const STRING_PRESETS = new Set(['string', 'optional-string'])
/** Names that read as "a list of things lives in here". */
const COLLECTION_NAME_RE = /(list|items?|entries|records|rows|sets|history|log|choices|map)$/i
/** Names that read as "this points at another block". `foo_id` (snake) is
 *  deliberately excluded: that's the shape the catalog recommends for
 *  *external* ids (`readwise:highlight_id`), which are not block refs. */
const POINTER_NAME_RE = /(^|[A-Za-z])(BlockId|blockId|Id|Ref|Refs)$|^(ref|refs|target|parent|owner)$/
/** Concepts the built-in `todo` type already owns. Bare `status` is NOT
 *  here — a domain status ("in-progress" → "done" for a whole session) is a
 *  real thing an extension may own, unlike done-ness itself. */
const TODO_CONCEPT_RE = /^(done|is-?done|completed?|complete|checked|due|due-?date|due-?at)$/i

const isLikelyCredentialKey = (key: string): boolean =>
  /token|secret|password|api[_-]?key|credentials?|auth/i.test(key)

// Match `window.localStorage.setItem(...)` / `localStorage.setItem(...)`
// — broad form first, then a follow-up to decide whether the key is a
// credential literal we should leave alone.
const LOCALSTORAGE_SET_RE = /(?:window\.)?localStorage\s*\.\s*setItem\s*\(\s*([^,)]+)/
// When the first arg is a string literal, extract the key value.
// (Captures both single- and double-quoted.)
const STRING_LITERAL_RE = /^\s*['"]([^'"]+)['"]\s*$/

// Dispatch of a `window` CustomEvent — captures the event-name token
// (string literal or identifier) so we can tell a dialog open/toggle
// intent apart from a genuine broadcast.
const DIALOG_EVENT_DISPATCH_RE =
  /window\s*\.\s*dispatchEvent\s*\(\s*new\s+CustomEvent\s*(?:<[^>]*>)?\s*\(\s*([^,)]+)/
// The event-name token reads like opening/toggling a dialog rather than
// a genuine broadcast. Deliberately favors low false positives over total
// recall: bare `show`/`close` are excluded (too common in non-dialog
// names like `show-toast` / `close-connection`), and names with no verb
// or surface noun (`...:settings`, `...:configure`, `...:data-synced`)
// are intentionally not caught — the goal is to flag the obvious
// `open-`/`toggle-`/`*-dialog` mistakes, not every possible opener.
const DIALOG_INTENT_RE = /open|toggle|dialog|picker|prompt|modal/i

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
    rule: 'dialog-via-window-event',
    catalogPattern: 'settings-dialog',
    message:
      'Opening or toggling a dialog by dispatching a `window` CustomEvent (and listening for it with `window.addEventListener` inside the component) reimplements the typed dialog channel over an untyped string bus. For a one-shot prompt, `openDialog(Component, props)` returns a promise that resolves with the user\'s choice. For a persistent toggle surface, drive visibility from a module store read via `useSyncExternalStore` (the same mechanism the app\'s own DialogHost uses) and flip it directly from your action\'s handler. Reserve `window` CustomEvents for genuine broadcast.',
    testLine(line) {
      // Flag a CustomEvent dispatch whose event name (literal or
      // identifier) reads like a dialog open/toggle intent. Genuine
      // broadcasts don't match the intent regex, so they're left
      // alone. We intentionally do NOT flag module stores or
      // `useSyncExternalStore` — that's the blessed mechanism.
      const match = line.match(DIALOG_EVENT_DISPATCH_RE)
      if (!match) return null
      const eventArg = (match[1] ?? '').trim()
      if (!DIALOG_INTENT_RE.test(eventArg)) return null
      return match[0]
    },
  },
  {
    rule: 'records-in-json-prop',
    catalogPattern: 'record-grain',
    message:
      'A list of records stored in one JSON property is a cell the rest of the app can\'t see into: you can\'t query an individual record in SQL, reference one, undo one edit, or hand-edit it in the outline — and a concurrent write clobbers the whole list. Make each record a child block with typed properties (see the `record-grain` guide). If the value is genuinely a list of scalars rather than records, use the `string-list` preset, or `refList` when the entries are block ids.',
    testSource(source) {
      for (const chunk of declarationChunks(source, 'seedProperty')) {
        const preset = stringField(chunk, 'preset')
        if (!preset || !JSON_PRESETS.has(preset)) continue
        const name = stringField(chunk, 'name') ?? ''
        if (!hasArrayDefault(chunk) && !COLLECTION_NAME_RE.test(localName(name))) continue
        return declarationExample('seedProperty', name)
      }
      return null
    },
  },
  {
    rule: 'block-id-as-string',
    catalogPattern: 'record-grain',
    message:
      'A property that points at another block should use the `ref` / `optional-ref` / `refList` preset with `config: {targetTypes: [...]}`, not a plain string. A ref projects into real references, so the target\'s backlinks show what points at it, retargeting follows moves, and the link survives renaming the target. A bare id string is invisible to all of that. (External ids — `readwise:highlight_id` and friends — are correctly plain strings; this rule only flags names that read like block pointers.)',
    testSource(source) {
      for (const chunk of declarationChunks(source, 'seedProperty')) {
        const preset = stringField(chunk, 'preset')
        if (!preset || !STRING_PRESETS.has(preset)) continue
        const name = stringField(chunk, 'name') ?? ''
        if (!POINTER_NAME_RE.test(localName(name))) continue
        return declarationExample('seedProperty', name)
      }
      return null
    },
  },
  {
    rule: 'unnamespaced-declaration',
    catalogPattern: 'record-grain',
    message:
      'Type ids and property names share one global namespace across every plugin and extension in the workspace. A bare noun (`set`, `entry`, `status`) collides with whatever else claims it, and the loser silently gets the other schema\'s codec. Prefix both with your extension: type `myext-set`, property `myext:weight`. If you meant to reuse an existing concept, import its schema instead of re-declaring the name.',
    testSource(source) {
      for (const chunk of declarationChunks(source, 'seedType')) {
        const id = stringField(chunk, 'id')
        if (id && !/[-:.]/.test(id)) return declarationExample('seedType', id)
      }
      for (const chunk of declarationChunks(source, 'seedProperty')) {
        const name = stringField(chunk, 'name')
        if (name && !name.includes(':')) return declarationExample('seedProperty', name)
      }
      return null
    },
  },
  {
    rule: 'reinvented-core-concept',
    catalogPattern: 'record-grain',
    message:
      'Done-ness and due dates already belong to the built-in `todo` type. Declaring your own means your records don\'t render as checkboxes, don\'t appear in todo queries or the agenda, and don\'t benefit from anything built on todos later. Compose instead: give the block BOTH types (`repo.addTypeInTx(tx, id, TODO_TYPE, {}, snapshot)`) and write the todo\'s own `status` prop, importing `{statusProp, TODO_TYPE}` from `@/plugins/todo/schema.js`. Keep your own property only for what todo does not model.',
    testSource(source) {
      for (const chunk of declarationChunks(source, 'seedProperty')) {
        const name = stringField(chunk, 'name')
        if (name && TODO_CONCEPT_RE.test(localName(name))) {
          return declarationExample('seedProperty', name)
        }
      }
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

  const record = (rule: LintRule, example: string): void => {
    warnings.push({
      rule: rule.rule,
      message: rule.message,
      catalogPattern: rule.catalogPattern,
      example: example.length > 120 ? `${example.slice(0, 117)}...` : example,
    })
  }

  for (const rule of rules) {
    if (suppressed.has(rule.rule)) continue
    // Take only the first hit per rule — agents don't need 12 copies
    // of the same warning; one is enough to act on, the others get
    // fixed alongside.
    if (rule.testSource) {
      const example = rule.testSource(source)
      if (example) record(rule, example)
      continue
    }
    if (!rule.testLine) continue
    for (const line of lines) {
      const example = rule.testLine(line)
      if (example) {
        record(rule, example)
        break
      }
    }
  }

  // Stable sort so the verify-result shape is deterministic across
  // runs of the same source.
  warnings.sort((a, b) => a.rule.localeCompare(b.rule))
  return warnings
}
