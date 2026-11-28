import type {ExportAllDeclaration, ExportNamedDeclaration, ImportDeclaration, Node, StringLiteral} from '@babel/types'

export type {Node, StringLiteral} from '@babel/types'

export type StaticModuleReference =
  | ImportDeclaration
  | ExportAllDeclaration
  | (ExportNamedDeclaration & {source: StringLiteral})

export function isStaticModuleReference(node: Node): node is StaticModuleReference {
  return node.type === 'ImportDeclaration'
    || node.type === 'ExportAllDeclaration'
    || (node.type === 'ExportNamedDeclaration' && node.source != null)
}

export function visitModuleSyntax(
  ast: unknown,
  visit: (node: Node, parent?: Node) => void,
): void {
  function walk(value: unknown, parent?: Node): void {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, parent)
      return
    }
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return
    // Babel's node children are nodes or arrays of nodes. Metadata such as
    // offsets and source locations does not have a node type.
    const node = value as Node
    visit(node, parent)
    for (const child of Object.values(node)) walk(child, node)
  }
  walk(ast)
}

type ModuleReference =
  | {kind: 'static'; source: StringLiteral}
  | {kind: 'dynamic' | 'require'; source: Node | undefined}

export function moduleReference(node: Node, includeCommonJs = false): ModuleReference | undefined {
  if (isStaticModuleReference(node)) return {kind: 'static', source: node.source}
  if (node.type === 'ImportExpression') return {kind: 'dynamic', source: node.source}
  if (!includeCommonJs) return
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
    return {kind: 'require', source: node.arguments[0]}
  }
  if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
    return {kind: 'require', source: node.moduleReference.expression}
  }
}

export function importedSpecifiers(ast: unknown, includeCommonJs = false): Array<string | undefined> {
  const specifiers: Array<string | undefined> = []
  visitModuleSyntax(ast, node => {
    const reference = moduleReference(node, includeCommonJs)
    if (reference) specifiers.push(reference.source && literalModuleSpecifier(reference.source))
  })
  return specifiers
}

export function staticModuleReferences(ast: unknown): StaticModuleReference[] {
  const references: StaticModuleReference[] = []
  visitModuleSyntax(ast, node => {
    if (isStaticModuleReference(node)) references.push(node)
  })
  return references
}

export function isTypeOnlyModuleReference(node: StaticModuleReference): boolean {
  if (node.type === 'ImportDeclaration') {
    return node.importKind === 'type' || node.importKind === 'typeof'
      || (node.specifiers.length > 0 && node.specifiers.every(specifier =>
        specifier.type === 'ImportSpecifier' && (specifier.importKind === 'type' || specifier.importKind === 'typeof')))
  }
  if (node.exportKind === 'type') return true
  return node.type === 'ExportNamedDeclaration' && node.specifiers.length > 0
    && node.specifiers.every(specifier => specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type')
}

export const extensionImportIntegrity = /^sha256-[A-Za-z0-9+/]{43}=$/

export function literalModuleSpecifier(node: Node): string | undefined {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
}

export function isUnsupportedImportMeta(node: Node, parent?: Node): boolean {
  if (node.type !== 'MetaProperty' || node.meta.name !== 'import') return false
  if (parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') {
    return parent.computed
      ? literalModuleSpecifier(parent.property) !== 'url'
      : parent.property.type !== 'Identifier' || parent.property.name !== 'url'
  }
  return true
}

export function isHttpsModuleSpecifier(specifier: string): boolean {
  return /^https:/i.test(specifier)
}

function integrityAttribute(node: StaticModuleReference) {
  return node.attributes?.find(({key}) => (key.type === 'Identifier' ? key.name : key.value) === 'integrity')
}

export function isRuntimeHttpsModuleReference(node: StaticModuleReference): boolean {
  return isHttpsModuleSpecifier(node.source.value) && !isTypeOnlyModuleReference(node)
}

export function isUnpinnedHttpsModuleReference(node: StaticModuleReference): boolean {
  return isRuntimeHttpsModuleReference(node) && !integrityAttribute(node)
}

export function unpinnedHttpsDynamicImport(node: Node): string | undefined {
  if (node.type !== 'ImportExpression') return
  const specifier = literalModuleSpecifier(node.source)
  return specifier && isHttpsModuleSpecifier(specifier) ? specifier : undefined
}

export function unpinnedExtensionImportUrls(ast: unknown): string[] {
  const urls = new Set<string>()
  visitModuleSyntax(ast, node => {
    if (isStaticModuleReference(node) && isUnpinnedHttpsModuleReference(node)) {
      urls.add(node.source.value)
    }
    const dynamicUrl = unpinnedHttpsDynamicImport(node)
    if (dynamicUrl) urls.add(dynamicUrl)
  })
  return [...urls]
}

export function readModuleIntegrity(node: StaticModuleReference): string | undefined {
  if (!node.attributes?.length) return
  const integrity = integrityAttribute(node)?.value.value ?? ''
  if (node.attributes.length !== 1 || !extensionImportIntegrity.test(integrity)) {
    throw new Error('An HTTPS extension import requires a SHA-256 integrity attribute')
  }
  return integrity
}

export function recordImportPin(pins: Map<string, string>, url: string, integrity: string): void {
  const previous = pins.get(url)
  if (previous && previous !== integrity) throw new Error(`Conflicting integrity values for ${url}`)
  pins.set(url, integrity)
}

export function collectModulePins(references: Iterable<StaticModuleReference>): Map<string, string> {
  const pins = new Map<string, string>()
  for (const reference of references) {
    if (!isRuntimeHttpsModuleReference(reference)) continue
    const integrity = readModuleIntegrity(reference)
    if (!integrity) continue
    recordImportPin(pins, reference.source.value, integrity)
  }
  return pins
}

export function sourcePinnedImports(ast: unknown): Map<string, string> {
  return collectModulePins(staticModuleReferences(ast))
}

/** Load the parser on demand so warm approvals without pins need no compiler. */
export async function extensionModuleParser() {
  return (await import('@babel/parser')).parse
}

export async function parseExtensionSource(source: string, tokens = false) {
  const parse = await extensionModuleParser()
  return parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx'], createImportExpressions: true, tokens})
}
