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
  if ((parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression')
    && parent.object === node) {
    return parent.computed
      ? literalModuleSpecifier(parent.property) !== 'url'
      : parent.property.type !== 'Identifier' || parent.property.name !== 'url'
  }
  return true
}

export function isHttpsModuleSpecifier(specifier: string): boolean {
  return /^https:/i.test(specifier)
}

export function unpinnedExtensionImportUrls(ast: unknown): string[] {
  const urls = new Set<string>()
  visitModuleSyntax(ast, node => {
    if (isStaticModuleReference(node) && !isTypeOnlyModuleReference(node)
      && isHttpsModuleSpecifier(node.source.value)
      && !node.attributes?.some(({key}) => (key.type === 'Identifier' ? key.name : key.value) === 'integrity')) {
      urls.add(node.source.value)
    }
    if (node.type === 'ImportExpression') {
      const specifier = literalModuleSpecifier(node.source)
      if (specifier && isHttpsModuleSpecifier(specifier)) urls.add(specifier)
    }
  })
  return [...urls]
}

export function readModuleIntegrity(node: StaticModuleReference): string | undefined {
  const attributes = node.attributes ?? []
  if (attributes.length === 0) return
  const [attribute] = attributes
  const name = attribute.key.type === 'Identifier' ? attribute.key.name : attribute.key.value
  const integrity = attribute.value.value
  if (attributes.length !== 1 || name !== 'integrity' || !extensionImportIntegrity.test(integrity)) {
    throw new Error('An HTTPS extension import requires a SHA-256 integrity attribute')
  }
  return integrity
}

export function recordImportPin(pins: Map<string, string>, url: string, integrity: string): void {
  const previous = pins.get(url)
  if (previous && previous !== integrity) throw new Error(`Conflicting integrity values for ${url}`)
  pins.set(url, integrity)
}

export function sourcePinnedImports(ast: unknown): Map<string, string> {
  const pins = new Map<string, string>()
  for (const reference of staticModuleReferences(ast)) {
    const url = reference.source.value
    if (!isHttpsModuleSpecifier(url) || isTypeOnlyModuleReference(reference)) continue
    const integrity = readModuleIntegrity(reference)
    if (!integrity) continue
    recordImportPin(pins, url, integrity)
  }
  return pins
}

/** Load the parser on demand so warm approvals without pins need no compiler. */
export async function extensionModuleParser() {
  return (await import('@babel/parser')).parse
}

export async function parseExtensionSource(source: string, tokens = false) {
  const parse = await extensionModuleParser()
  return parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx'], createImportExpressions: true, tokens})
}
