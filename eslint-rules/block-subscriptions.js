const BLOCK_HOOK_SOURCES = new Set([
  '@/hooks/block',
  '@/hooks/block.ts',
])

const normalizePath = (value) => value.replaceAll('\\', '/')

const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

const isAllowedFile = (filename, allowedFiles = []) =>
  allowedFiles.some(allowed => filename.endsWith(normalizePath(allowed)))

const isBlockHookSource = (value) => {
  if (typeof value !== 'string') return false
  const source = normalizePath(value)
  return BLOCK_HOOK_SOURCES.has(source) || /(^|\/)hooks\/block(\.ts)?$/.test(source)
}

const importName = (specifier) => {
  if (specifier.imported?.type === 'Identifier') return specifier.imported.name
  if (specifier.imported?.type === 'Literal') return specifier.imported.value
  return undefined
}

const keyName = (key) => {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal') return key.value
  return undefined
}

const hasSelectorProperty = (node) =>
  node.type === 'ObjectExpression'
  && node.properties.some(property =>
    property.type === 'Property' && keyName(property.key) === 'selector',
  )

const getSelectorNode = (node) => {
  if (node.type !== 'ObjectExpression') return null
  const property = node.properties.find(property =>
    property.type === 'Property' && keyName(property.key) === 'selector',
  )
  return property?.type === 'Property' ? property.value : null
}

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

const returnedExpression = (node) => {
  if (!node) return null
  if (node.type === 'ArrowFunctionExpression') {
    if (node.body.type !== 'BlockStatement') return node.body
    const statement = node.body.body.find(child => child.type === 'ReturnStatement')
    return statement?.argument ?? null
  }
  if (node.type === 'FunctionExpression') {
    const statement = node.body.body.find(child => child.type === 'ReturnStatement')
    return statement?.argument ?? null
  }
  return null
}

const isContentMember = (node) => {
  const expression = unwrap(node)
  return expression?.type === 'MemberExpression'
    && !expression.computed
    && expression.property.type === 'Identifier'
    && expression.property.name === 'content'
}

const isContentSelectorExpression = (node) => {
  const expression = unwrap(node)
  if (isContentMember(expression)) return true
  if (
    expression?.type === 'LogicalExpression'
    && expression.operator === '??'
    && isContentMember(expression.left)
    && expression.right.type === 'Literal'
    && expression.right.value === ''
  ) {
    return true
  }
  return false
}

const noBroadBlockSubscriptions = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow broad block subscriptions in React components.',
    },
    schema: [{
      type: 'object',
      additionalProperties: false,
      properties: {
        allowUseDataIn: {
          type: 'array',
          items: {type: 'string'},
        },
      },
    }],
    messages: {
      noUseData: 'useData subscribes to the full block row. Use a semantic hook or useHandle with a narrow selector.',
      missingSelector: 'useHandle must be called with an inline selector object to avoid broad subscriptions.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {}
    const filename = getFilename(context)
    const useDataNames = new Set()
    const useHandleNames = new Set()

    return {
      ImportDeclaration(node) {
        if (!isBlockHookSource(node.source.value)) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue
          const imported = importName(specifier)
          if (imported === 'useData') useDataNames.add(specifier.local.name)
          if (imported === 'useHandle') useHandleNames.add(specifier.local.name)
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return
        if (useDataNames.has(node.callee.name) && !isAllowedFile(filename, options.allowUseDataIn)) {
          context.report({node, messageId: 'noUseData'})
          return
        }
        if (!useHandleNames.has(node.callee.name)) return
        const optionsArg = node.arguments[1]
        if (!optionsArg || optionsArg.type !== 'ObjectExpression' || !hasSelectorProperty(optionsArg)) {
          context.report({node, messageId: 'missingSelector'})
        }
      },
    }
  },
}

const preferSemanticBlockHooks = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer named block hooks over raw useHandle selectors for common fields.',
    },
    schema: [{
      type: 'object',
      additionalProperties: false,
      properties: {
        allowIn: {
          type: 'array',
          items: {type: 'string'},
        },
      },
    }],
    messages: {
      useContent: 'Use useContent(block) instead of a raw useHandle content selector.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {}
    const filename = getFilename(context)
    const useHandleNames = new Set()

    return {
      ImportDeclaration(node) {
        if (!isBlockHookSource(node.source.value)) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue
          if (importName(specifier) === 'useHandle') useHandleNames.add(specifier.local.name)
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return
        if (!useHandleNames.has(node.callee.name)) return
        if (isAllowedFile(filename, options.allowIn)) return

        const selector = getSelectorNode(node.arguments[1])
        if (selector && isContentSelectorExpression(returnedExpression(selector))) {
          context.report({node, messageId: 'useContent'})
        }
      },
    }
  },
}

export default {
  rules: {
    'no-broad-block-subscriptions': noBroadBlockSubscriptions,
    'prefer-semantic-block-hooks': preferSemanticBlockHooks,
  },
}
