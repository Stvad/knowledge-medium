// Guardrail for the properties-as-blocks child-visibility model (PR #288/#386):
// `tx.childrenOf` / `repo.query.{children,subtree,childIds}` default to the
// STRUCTURAL everything-view (every child, including hidden property field-row
// machinery). The VISIBLE / outline view (machinery excluded, §9) is opt-in via
// `hidePropertyChildren: true` (or the `visibleChildrenOf` helper).
//
// In pure outline/display modules the visible view is nearly always what's
// wanted, and a forgotten opt-in silently leaks machinery into a user-facing
// traversal — mis-picked as an indent target, rendered as a panel, serialized
// into the clipboard. This rule forces the choice to be explicit there. It is
// deliberately NOT applied to the mixed data-layer files (mutators, paste,
// panelLayoutProjection) that legitimately interleave both views — those use
// the named `visibleChildrenOf` helper so the two spellings sit side by side.

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
        'Outline/display code must choose the child view explicitly (visible vs. structural).',
    },
    // `check` picks how much of the surface to guard:
    //   'all'   — query handles AND `tx.childrenOf`. For pure display dirs,
    //             where every traversal is a display read.
    //   'query' — query handles only. The default everywhere else: a
    //             `repo.query.{children,subtree,childIds}({id})` is a READ-OUT
    //             (render, serialize, hand to an agent) and every such call
    //             site in `src/` wants the visible view, while `tx.childrenOf`
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
        'Choose the child view explicitly: use `visibleChildrenOf(tx, …)` or pass '
        + '`hidePropertyChildren` (true = visible outline view, false = structural '
        + 'everything-view). The bare call returns ALL children, including hidden '
        + 'property field-row machinery (PR #288/#386).',
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
          if (!node.arguments.some(arg => objHasKey(arg, 'hidePropertyChildren'))) {
            context.report({node, messageId: 'explicitChildView'})
          }
          return
        }

        if (QUERY_METHODS.has(name)) {
          const first = node.arguments[0]
          // Match only the query-handle shape `…query.<m>({id: …})`; array
          // `.children`, `slot.subtree`, etc. never take an `{id}` options arg.
          if (!objHasKey(first, 'id')) return
          if (!objHasKey(first, 'hidePropertyChildren')) {
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
