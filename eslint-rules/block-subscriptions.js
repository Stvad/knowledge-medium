const BLOCK_HOOK_SOURCES = new Set([
  '@/hooks/block',
  '@/hooks/block.ts',
])

const normalizePath = (value) => value.replaceAll('\\', '/')

const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

const isAllowedFile = (filename, allowedFiles = []) =>
  allowedFiles.some(allowed => filename.endsWith(normalizePath(allowed)))

const isTestFile = (filename) =>
  /(^|\/)test\//.test(filename) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filename)

const isBlockHookSource = (value) => {
  if (typeof value !== 'string') return false
  const source = normalizePath(value)
  return BLOCK_HOOK_SOURCES.has(source) || /(^|\/)hooks\/block(\.ts)?$/.test(source)
}

const isPropertiesSource = (value, filename) => {
  if (typeof value !== 'string') return false
  const source = normalizePath(value)
  return source === '@/data/properties'
    || source === '@/data/properties.ts'
    || /(^|\/)data\/properties(\.ts)?$/.test(source)
    || (
      /(^|\/)src\/data\//.test(filename)
      && (source === './properties' || source === './properties.ts')
    )
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

const memberPropertyName = (node) => {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal') return node.value
  return undefined
}

const parentAfterExpressionWrappers = (node) => {
  let current = node
  let parent = current.parent
  while (
    parent?.type === 'TSAsExpression'
    || parent?.type === 'TSSatisfiesExpression'
    || parent?.type === 'TSNonNullExpression'
    || parent?.type === 'TSTypeAssertion'
  ) {
    current = parent
    parent = current.parent
  }
  return parent
}

const noDirectTypesPropWrites = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct runtime writes to the raw typesProp field.',
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
      directWrite: 'Direct typesProp writes bypass Repo type invariants. Use repo.addType/addTypeInTx/removeType/setBlockTypes, or addBlockTypeToProperties only while planning raw BlockData.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {}
    const filename = getFilename(context)
    const typesPropNames = new Set()

    const shouldSkip = () => isTestFile(filename) || isAllowedFile(filename, options.allowIn)
    const isTypesPropIdentifier = (node) =>
      node?.type === 'Identifier' && typesPropNames.has(node.name)
    const isTypesPropNameMember = (node) => {
      const expression = unwrap(node)
      return expression?.type === 'MemberExpression'
        && !expression.computed
        && isTypesPropIdentifier(unwrap(expression.object))
        && memberPropertyName(expression.property) === 'name'
    }
    const isTypesPropIndexedWrite = (node) => {
      const expression = unwrap(node)
      return expression?.type === 'MemberExpression'
        && expression.computed
        && isTypesPropNameMember(expression.property)
    }
    const isTypesLiteral = (node) => {
      const expression = unwrap(node)
      return expression?.type === 'Literal' && expression.value === 'types'
    }
    const isPropertiesObjectReference = (node) => {
      const expression = unwrap(node)
      if (expression?.type === 'Identifier') return expression.name === 'properties'
      return expression?.type === 'MemberExpression'
        && memberPropertyName(expression.property) === 'properties'
    }
    const hasPropertiesSpread = (objectExpression) =>
      objectExpression.properties.some(property =>
        property.type === 'SpreadElement' && isPropertiesObjectReference(property.argument),
      )
    const isRawPropertiesPayloadObject = (objectExpression) => {
      const parent = parentAfterExpressionWrappers(objectExpression)
      if (parent?.type === 'Property' && keyName(parent.key) === 'properties') return true
      if (
        parent?.type === 'VariableDeclarator'
        && parent.id.type === 'Identifier'
        && parent.id.name === 'properties'
      ) {
        return true
      }
      if (
        parent?.type === 'AssignmentExpression'
        && parent.left.type === 'Identifier'
        && parent.left.name === 'properties'
      ) {
        return true
      }
      return hasPropertiesSpread(objectExpression)
    }
    const isTypesLiteralProperty = (node) =>
      keyName(node.key) === 'types' || (node.computed && isTypesLiteral(node.key))
    const isTypesLiteralMemberWrite = (node) => {
      const expression = unwrap(node)
      return expression?.type === 'MemberExpression'
        && memberPropertyName(expression.property) === 'types'
        && isPropertiesObjectReference(expression.object)
    }
    const isBlockLikeSetCallee = (callee) => {
      const expression = unwrap(callee)
      if (expression?.type !== 'MemberExpression') return false
      if (memberPropertyName(expression.property) !== 'set') return false
      const object = unwrap(expression.object)
      return object?.type === 'Identifier'
        && (object.name === 'block' || object.name.endsWith('Block'))
    }
    const report = (node) => {
      if (!shouldSkip()) context.report({node, messageId: 'directWrite'})
    }

    return {
      ImportDeclaration(node) {
        if (!isPropertiesSource(node.source.value, filename)) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue
          if (importName(specifier) === 'typesProp') typesPropNames.add(specifier.local.name)
        }
      },
      Property(node) {
        if (node.parent?.type !== 'ObjectExpression') return
        if (node.computed && isTypesPropNameMember(node.key)) report(node.key)
        if (isTypesLiteralProperty(node) && isRawPropertiesPayloadObject(node.parent)) {
          report(node.key)
        }
      },
      AssignmentExpression(node) {
        if (isTypesPropIndexedWrite(node.left)) report(node.left)
        if (isTypesLiteralMemberWrite(node.left)) report(node.left)
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        if (callee?.type !== 'MemberExpression') return
        const propertyName = memberPropertyName(callee.property)
        if (propertyName === 'setProperty' && isTypesPropIdentifier(unwrap(node.arguments[1]))) {
          report(node.arguments[1])
        }
        if (propertyName === 'setProperty' && isTypesLiteral(node.arguments[1])) {
          report(node.arguments[1])
        }
        if (propertyName === 'setProperty') {
          const argsObject = unwrap(node.arguments[0])
          const schemaProperty = argsObject?.type === 'ObjectExpression'
            ? argsObject.properties.find(property =>
              property.type === 'Property' &&
              keyName(property.key) === 'schema' &&
              isTypesLiteral(property.value),
            )
            : undefined
          if (schemaProperty?.type === 'Property') report(schemaProperty.value)
        }
        if (propertyName === 'set' && isTypesPropIdentifier(unwrap(node.arguments[0]))) {
          report(node.arguments[0])
        }
        if (isBlockLikeSetCallee(callee) && isTypesLiteral(node.arguments[0])) {
          report(node.arguments[0])
        }
      },
    }
  },
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
    'no-direct-types-prop-writes': noDirectTypesPropWrites,
    'no-broad-block-subscriptions': noBroadBlockSubscriptions,
    'prefer-semantic-block-hooks': preferSemanticBlockHooks,
  },
}
