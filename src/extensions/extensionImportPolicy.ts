import {
  isHttpsModuleSpecifier, isStaticModuleReference, isTypeOnlyModuleReference, isUnsupportedImportMeta, readModuleIntegrity, recordImportPin,
  literalModuleSpecifier, moduleReference, visitModuleSyntax, type Node,
} from '@knowledge-medium/agent-cli/extensionImportSyntax'

interface ExtensionImportManifest {
  exactPageImports: Readonly<Record<string, string>>
  sourceSpecifiers: readonly string[]
}

const buildManifest = typeof __EXTENSION_IMPORT_MANIFEST__ === 'undefined'
  ? {exactPageImports: {}, sourceSpecifiers: []}
  : __EXTENSION_IMPORT_MANIFEST__
const vendoredScheme = 'km-vendored:'
const liveScheme = 'km-live:'

export const vendoredImportSpecifier = (integrity: string): string => vendoredScheme + integrity
// Generated JSX specifiers append a slash and runtime subpath. Encode the
// entire URL so that suffix cannot match an authored import's placeholder.
const liveImportSpecifier = (url: string): string => liveScheme + encodeURIComponent(url)

type ExtensionImport =
  | {kind: 'page'; target: string}
  | {kind: 'source'; specifier: string}
  | {kind: 'vendored'; integrity: string}
  | {kind: 'live'; url: string}

interface ImportGrants {
  vendoredSpecifiers?: ReadonlySet<string>
  liveSpecifiers?: ReadonlySet<string>
}

function findExtensionImport(
  specifier: string,
  grants: ImportGrants,
  manifest: ExtensionImportManifest,
): ExtensionImport | undefined {
  const {exactPageImports, sourceSpecifiers} = manifest
  if (Object.hasOwn(exactPageImports, specifier)) return {kind: 'page', target: exactPageImports[specifier]}
  if (sourceSpecifiers.includes(specifier)) return {kind: 'source', specifier}
  if (grants.vendoredSpecifiers?.has(specifier)) {
    return {kind: 'vendored', integrity: specifier.slice(vendoredScheme.length)}
  }
  if (grants.liveSpecifiers?.has(specifier)) {
    return {kind: 'live', url: decodeURIComponent(specifier.slice(liveScheme.length))}
  }
}

export function resolveExtensionImport(
  specifier: string,
  grants: ImportGrants = {},
  manifest: ExtensionImportManifest = buildManifest,
): ExtensionImport {
  const resolved = findExtensionImport(specifier, grants, manifest)
  if (!resolved) throw new Error(`Extension import is not allowed: ${specifier}`)
  return resolved
}

export function runnableSpecifier(specifier: string): boolean {
  return findExtensionImport(specifier, {}, buildManifest) !== undefined
}

function rejectAuthoredPlaceholder(specifier: string): void {
  if (specifier.startsWith(vendoredScheme) || specifier.startsWith(liveScheme)) {
    throw new Error('Extension source cannot use a reserved import specifier')
  }
}

export function createExtensionImportTransform() {
  const pinnedImports = new Map<string, string>()
  const unpinnedImports = new Set<string>()

  function rewriteLive(url: string): string {
    unpinnedImports.add(url)
    return liveImportSpecifier(url)
  }

  const plugin = () => ({
    visitor: {
      // Read only the original program. A generated HTTPS import must never
      // inherit the grant of an authored import with the same URL.
      Program(path: {node: unknown}) {
        visitModuleSyntax(path.node, node => {
          if (isStaticModuleReference(node)) {
            const url = node.source.value
            rejectAuthoredPlaceholder(url)
            if (!isHttpsModuleSpecifier(url) || isTypeOnlyModuleReference(node)) return
            const integrity = readModuleIntegrity(node)
            if (!integrity) {
              node.source.value = rewriteLive(url)
              return
            }
            recordImportPin(pinnedImports, url, integrity)
            node.source.value = vendoredImportSpecifier(integrity)
            node.attributes = []
          }
          if (node.type === 'ImportExpression') {
            const url = literalModuleSpecifier(node.source)
            if (url === undefined) return
            rejectAuthoredPlaceholder(url)
            if (!isHttpsModuleSpecifier(url)) return
            if (node.options) throw new Error('Pin HTTPS dynamic imports by moving them to a static import')
            node.source = {type: 'StringLiteral', value: rewriteLive(url)}
          }
        })
      },
    },
  })
  return {pinnedImports, unpinnedImports, plugin}
}

interface ImportReference {
  start: number
  end: number
}

interface ExtensionImportReplacement extends ImportReference {
  value: string
}

function referenceRange(node: Node): ImportReference {
  if (node.start == null || node.end == null) throw new Error('Extension import has no source range')
  return {start: node.start, end: node.end}
}

function replaceExtensionImportReferences(
  compiled: string,
  replacements: readonly ExtensionImportReplacement[],
): string {
  let end = compiled.length
  let code = ''
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    code = JSON.stringify(replacement.value) + compiled.slice(replacement.end, end) + code
    end = replacement.start
  }
  return compiled.slice(0, end) + code
}

type ParseCompiled = (compiled: string, options: {sourceType: 'module'}) => unknown

interface CompiledImportGrants {
  pinnedImports: ReadonlyMap<string, string>
  unpinnedImports: ReadonlySet<string>
  allowUnpinnedLive: boolean
  manifest?: ExtensionImportManifest
}

export function assertCompiledExtensionImports(
  parse: ParseCompiled,
  compiled: string,
  grants: CompiledImportGrants,
) {
  const liveReplacements: ExtensionImportReplacement[] = []
  const importGrants = {
    vendoredSpecifiers: new Set([...grants.pinnedImports.values()].map(vendoredImportSpecifier)),
    liveSpecifiers: new Set([...grants.unpinnedImports].map(liveImportSpecifier)),
  }

  function check(source: Node) {
    const specifier = literalModuleSpecifier(source)
    if (specifier === undefined) throw new Error('Extension import() requires a literal module specifier')
    const resolved = resolveExtensionImport(specifier, importGrants, grants.manifest)
    if (resolved.kind === 'live') {
      if (!grants.allowUnpinnedLive) throw new Error(`Extension import requires an integrity pin: ${resolved.url}`)
      liveReplacements.push({...referenceRange(source), value: resolved.url})
    }
  }

  visitModuleSyntax(parse(compiled, {sourceType: 'module'}), (node, parent) => {
    const reference = moduleReference(node)
    if (reference?.source) check(reference.source)
    if (isUnsupportedImportMeta(node, parent)) throw new Error('Extensions can only access import.meta.url')
  })

  return {
    compiled: replaceExtensionImportReferences(compiled, liveReplacements),
    importsUnpinned: liveReplacements.length > 0,
  }
}

export function linkVendoredImports(
  parse: ParseCompiled,
  compiled: string,
  urlFor: (integrity: string) => string,
): string {
  if (!compiled.includes(vendoredScheme)) return compiled
  const replacements: ExtensionImportReplacement[] = []
  visitModuleSyntax(parse(compiled, {sourceType: 'module'}), node => {
    if (!isStaticModuleReference(node)) return
    const specifier = node.source.value
    if (specifier.startsWith(vendoredScheme)) {
      replacements.push({
        ...referenceRange(node.source),
        value: urlFor(specifier.slice(vendoredScheme.length)),
      })
    }
  })
  return replaceExtensionImportReferences(compiled, replacements)
}
