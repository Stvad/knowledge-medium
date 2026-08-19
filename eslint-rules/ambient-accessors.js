/**
 * ambient-accessors — generic "ambient global read outside its injected
 * channel" restriction, driven by the table in ambientAccessors.data.js
 * (see that file for the entry shapes and how it's maintained).
 *
 * Replaces the DI-lens audit's (PR #357 / PR #424) per-global
 * eslint.config.js entries — a no-restricted-imports `paths` pair for
 * getActiveUserId, a no-restricted-syntax selector each for
 * navigator.platform and the mobile-breakpoint literal — with ONE rule
 * that fans out over a maintained table. Adding a new restriction is a
 * table edit (or, for a tagged export, just the tag — see
 * scripts/gen-ambient-accessors.ts), never a new rule instance.
 *
 * Three entry kinds:
 *   - kind:'import'  — an ImportDeclaration specifier importing one of
 *     `names` from `module`, matched two ways: (1) the alias-style
 *     specifier (`@/data/repoProvider`, bare or `.ts`/`.js`-suffixed —
 *     what the old no-restricted-imports `paths` matched), or (2) ANY
 *     relative specifier (`./...`, `../...`), resolved against the
 *     linted file's own repo-relative directory (posix join + normalize,
 *     extension stripped) and compared to the module's `src/...` path.
 *     The resolve is exact, not a heuristic, so one code path covers a
 *     same-dir import (`./repoProvider` from src/data/), a parent-relative
 *     import still under the module's own tree (`../repoProvider` from
 *     src/data/internals/), and a deep cross-tree import
 *     (`../../data/repoProvider` from src/plugins/foo/) alike.
 *     A namespace import (`import * as provider from '@/data/repoProvider'`)
 *     of a matched module is also tracked per matched local name, so a
 *     later `provider.getActiveUserId(...)` member access is flagged the
 *     same as the named-import form — a plain per-file local-name → entry
 *     map, no scope analysis, so a shadowing local with the same name in a
 *     nested scope is (rarely) mis-flagged; not worth the complexity here.
 *   - kind:'member'  — a MemberExpression reading `object.property`,
 *     INCLUDING computed string access (`navigator['platform']`) — a gap
 *     the old no-restricted-syntax selector
 *     (`MemberExpression[object.name=...][property.name=...]`) left open
 *     because `property.name` only matches a non-computed Identifier.
 *     The object side also unwraps a leading `window.`/`globalThis.`
 *     wrapper (dot form only, e.g. `window.navigator.platform` /
 *     `globalThis.navigator.platform`), mirroring the DI-lens audit's
 *     window/globalThis navigator.platform ban — so `entry.object` still
 *     names the bare global (`navigator`) and every member entry gets the
 *     wrapper-unwrap for free.
 *   - kind:'literal' — a string Literal OR a no-substitution
 *     TemplateLiteral (a single quasi, e.g. `` `(max-width: 767px)` ``)
 *     equal to `value` — the old Literal-value selector only matched
 *     plain string literals, not the equivalent template form.
 *
 * `allowIn` is a per-entry allowlist of repo-relative file paths (suffix
 * match, same helper as block-subscriptions.js) — the entries carry their
 * own exemptions instead of a separate eslint.config.js override block
 * per restriction. The rule applies unconditionally to every matched
 * file, including tests: unlike the retired B3 CustomEvent selector
 * (tests legitimately dispatch synthetic events), there's no test-only
 * reason to read an ambient global or duplicate a shared literal.
 */

import { posix } from 'node:path'

const normalizePath = (value) => value.replaceAll('\\', '/')

const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

const isAllowedFile = (filename, allowedFiles = []) =>
  allowedFiles.some(allowed => filename.endsWith(normalizePath(allowed)))

const unwrap = (node) => {
  let current = node
  while (
    current?.type === 'ChainExpression'
    || current?.type === 'TSNonNullExpression'
    || current?.type === 'TSAsExpression'
    || current?.type === 'TSTypeAssertion'
  ) {
    current = current.expression
  }
  return current
}

// --- kind:'import' -----------------------------------------------------

// `module` is always '@/...'; strip the alias to the src/-relative path
// (e.g. '@/data/repoProvider' -> 'data/repoProvider').
const moduleRelativePath = (module) => module.replace(/^@\//, '')

// The linted file's own repo-relative DIRECTORY (e.g.
// '/repo/src/data/internals/foo.ts' -> 'src/data/internals'), found by
// locating the 'src' path segment — filenames are either a real absolute
// path (real lint runs) or a fabricated one (RuleTester), but both always
// contain a literal 'src/...' segment. Returns undefined if the filename
// has no 'src' segment (nothing to resolve against).
const repoRelativeDir = (filename) => {
  const parts = filename.split('/')
  const srcIndex = parts.lastIndexOf('src')
  if (srcIndex === -1) return undefined
  return parts.slice(srcIndex, -1).join('/')
}

// Resolve a relative import specifier ('./...' / '../...') against the
// linted file's directory into a src/-relative path, extension stripped —
// a real resolve (posix join + normalize), not a suffix heuristic, so it
// handles same-dir, parent-relative, and deep cross-tree relative imports
// with one code path.
const resolveRelativeImport = (filename, source) => {
  const dir = repoRelativeDir(filename)
  if (dir === undefined) return undefined
  return posix.join(dir, source).replace(/\.[jt]sx?$/, '')
}

const isImportSourceMatch = (sourceValue, filename, module) => {
  if (typeof sourceValue !== 'string') return false
  const source = normalizePath(sourceValue)
  const relative = moduleRelativePath(module)

  // Alias-style absolute specifier.
  if (source === `@/${relative}` || source === `@/${relative}.ts` || source === `@/${relative}.js`) {
    return true
  }

  // Relative specifier — resolve, don't guess.
  if (source.startsWith('./') || source.startsWith('../')) {
    return resolveRelativeImport(filename, source) === `src/${relative}`
  }

  return false
}

const importedName = (specifier) => {
  if (specifier.imported?.type === 'Identifier') return specifier.imported.name
  if (specifier.imported?.type === 'Literal') return specifier.imported.value
  return undefined
}

// --- kind:'member' -------------------------------------------------------

// Does `objectNode` name the global `name`, read either directly
// (`navigator`) or through a `window.`/`globalThis.` wrapper
// (`window.navigator` / `globalThis.navigator`, dot form only — the
// wrapper step itself isn't defended against bracket-notation
// obfuscation, same as the config selector this rule subsumed)?
const isGlobalObjectMatch = (objectNode, name) => {
  const object = unwrap(objectNode)
  if (object?.type === 'Identifier') return object.name === name
  if (object?.type !== 'MemberExpression' || object.computed) return false
  const wrapper = unwrap(object.object)
  return wrapper?.type === 'Identifier'
    && (wrapper.name === 'window' || wrapper.name === 'globalThis')
    && object.property.type === 'Identifier'
    && object.property.name === name
}

const isMemberMatch = (node, entry) => {
  if (node.type !== 'MemberExpression') return false
  if (!isGlobalObjectMatch(node.object, entry.object)) return false

  if (!node.computed) {
    return node.property.type === 'Identifier' && node.property.name === entry.property
  }
  const property = unwrap(node.property)
  return property?.type === 'Literal' && property.value === entry.property
}

// --- kind:'literal' --------------------------------------------------------

const templateLiteralValue = (node) => {
  if (node.expressions.length !== 0) return undefined
  return node.quasis[0]?.value?.cooked
}

const ambientAccessors = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow reading an ambient global outside its injected channel (table-driven).',
    },
    schema: [{
      type: 'object',
      additionalProperties: false,
      properties: {
        entries: {
          type: 'array',
          items: {type: 'object'},
        },
      },
    }],
    messages: {
      // Mirrors ESLint core's own no-restricted-syntax: one messageId,
      // the per-entry text interpolated as `data.message`.
      ambientAccess: '{{message}}',
    },
  },
  create(context) {
    const options = context.options[0] ?? {}
    const entries = options.entries ?? []
    const filename = getFilename(context)

    const importEntries = entries.filter(entry => entry.kind === 'import')
    const memberEntries = entries.filter(entry => entry.kind === 'member')
    const literalEntries = entries.filter(entry => entry.kind === 'literal')

    const report = (node, entry) => {
      if (isAllowedFile(filename, entry.allowIn)) return
      context.report({node, messageId: 'ambientAccess', data: {message: entry.message}})
    }

    // Namespace-import locals (`import * as x from '<matched module>'`)
    // seen so far in THIS file, local name -> the import entries it can
    // stand in for. A later `x.<restrictedName>` member access is flagged
    // the same as a named import would be. Plain per-file map, no scope
    // analysis — see the header comment's shadowing caveat.
    const namespaceLocals = new Map()

    const namespaceMemberName = (node) => {
      if (!node.computed) {
        return node.property.type === 'Identifier' ? node.property.name : undefined
      }
      const property = unwrap(node.property)
      return property?.type === 'Literal' && typeof property.value === 'string' ? property.value : undefined
    }

    return {
      ImportDeclaration(node) {
        if (importEntries.length === 0) return
        for (const entry of importEntries) {
          if (!isImportSourceMatch(node.source.value, filename, entry.module)) continue
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier') {
              if (entry.names.includes(importedName(specifier))) report(specifier, entry)
            } else if (specifier.type === 'ImportNamespaceSpecifier') {
              const local = specifier.local.name
              if (!namespaceLocals.has(local)) namespaceLocals.set(local, new Set())
              namespaceLocals.get(local).add(entry)
            }
          }
        }
      },
      MemberExpression(node) {
        for (const entry of memberEntries) {
          if (isMemberMatch(node, entry)) report(node, entry)
        }
        if (namespaceLocals.size === 0) return
        const object = unwrap(node.object)
        if (object?.type !== 'Identifier' || !namespaceLocals.has(object.name)) return
        const accessedName = namespaceMemberName(node)
        if (accessedName === undefined) return
        for (const entry of namespaceLocals.get(object.name)) {
          if (entry.names.includes(accessedName)) report(node, entry)
        }
      },
      Literal(node) {
        if (typeof node.value !== 'string') return
        for (const entry of literalEntries) {
          if (node.value === entry.value) report(node, entry)
        }
      },
      TemplateLiteral(node) {
        if (literalEntries.length === 0) return
        const value = templateLiteralValue(node)
        if (value === undefined) return
        for (const entry of literalEntries) {
          if (value === entry.value) report(node, entry)
        }
      },
    }
  },
}

export default {
  rules: {
    'ambient-accessors': ambientAccessors,
  },
}
