// Guardrail for the properties-as-blocks child views: a child listing is
// always a VIEW (`propertyChildren`: `'all'` every child, `'non-hidden'`,
// `'none'` no recognized property field row), and
// `tx.childrenOf` / `repo.query.{children,subtree,childIds}` answer `'all'`
// when the caller says nothing.
//
// In outline/display modules a forgotten view silently puts property rows
// into a user-facing traversal — mis-picked as an indent target, rendered as a
// panel, serialized into the clipboard. This rule makes the caller name the
// view there. The list a SURFACE draws is not a fixed view: gesture code reads
// it through `visibleChildIds(block, scope)` / `visibleChildrenOf(tx, …,
// scope)` (`src/data/visibleChildren.ts`), which this rule does not police.

const normalizePath = (value) => value.replaceAll('\\', '/')

const getFilename = (context) =>
  normalizePath(context.filename ?? context.getFilename?.() ?? '')

const isTestFile = (filename) =>
  /(^|\/)test\//.test(filename) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filename)

const keyName = (key) => {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal') return key.value
  return undefined
}

const objHasKey = (node, name) =>
  node?.type === 'ObjectExpression'
  && node.properties.some(
    property => property.type === 'Property' && keyName(property.key) === name,
  )

const QUERY_METHODS = new Set(['children', 'subtree', 'childIds'])

const requireExplicitChildView = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Outline/display code must name the child view it reads (`propertyChildren`).',
    },
    // `check` picks how much of the surface to guard:
    //   'all'   — query handles AND `tx.childrenOf`. For pure display dirs,
    //             where every traversal is a display read.
    //   'query' — query handles only. The default everywhere else: a
    //             `repo.query.{children,subtree,childIds}({id})` is a READ-OUT
    //             (render, serialize, hand to an agent) and every such call
    //             site in `src/` wants a view it can name, while `tx.childrenOf`
    //             is the low-level primitive that mixed data-layer files
    //             (mutators, paste, panelLayoutProjection, agent-runtime)
    //             legitimately call structurally for order-key/sibling math.
    schema: [{
      type: 'object',
      properties: {check: {enum: ['all', 'query']}},
      additionalProperties: false,
    }],
    messages: {
      explicitChildView:
        'Name the child view: pass `propertyChildren` (`\'none\'` = no property rows, '
        + '`\'non-hidden\'` = property rows whose definition is not hidden, `\'all\'` = every '
        + 'child). For the list a surface DRAWS, which a gesture should walk, use '
        + '`visibleChildIds(block, scope)` / `visibleChildrenOf(tx, …, scope)` instead. '
        + 'The bare call returns every child, property field rows included.',
    },
  },
  create(context) {
    if (isTestFile(getFilename(context))) return {}
    const check = context.options[0]?.check ?? 'all'
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.computed) return
        if (callee.property.type !== 'Identifier') return
        const name = callee.property.name

        if (name === 'childrenOf') {
          if (check !== 'all') return
          // Options is the trailing arg; scan every arg for the flag object so
          // the 2-arg and 3-arg spellings are both covered.
          if (!node.arguments.some(arg => objHasKey(arg, 'propertyChildren'))) {
            context.report({node, messageId: 'explicitChildView'})
          }
          return
        }

        if (QUERY_METHODS.has(name)) {
          const first = node.arguments[0]
          // Match only the query-handle shape `…query.<m>({id: …})`; array
          // `.children`, `slot.subtree`, etc. never take an `{id}` options arg.
          if (!objHasKey(first, 'id')) return
          if (!objHasKey(first, 'propertyChildren')) {
            context.report({node, messageId: 'explicitChildView'})
          }
        }
      },
    }
  },
}

export default {
  rules: {
    'require-explicit-child-view': requireExplicitChildView,
  },
}
