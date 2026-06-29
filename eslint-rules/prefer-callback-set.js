/**
 * prefer-callback-set — nudge hand-rolled listener registries toward the shared
 * `CallbackSet` primitive (`@/utils/callbackSet`).
 *
 * A `Set` whose element type is a function literal — `new Set<() => void>()`, or
 * a `Set<(x: T) => void>` field/annotation — is almost always a listener
 * fan-out that re-implements the add / notify / unsubscribe loop CallbackSet
 * already provides. CallbackSet additionally snapshots the listener set before
 * iterating (so a subscriber that unsubscribes mid-callback can't skip a
 * neighbour) and isolates listener exceptions — both easy to forget by hand,
 * and both real bugs we've shipped from re-rolling the pattern.
 *
 * Warning-level on purpose: the occasional function-Set is NOT a listener
 * registry (a teardown/cleanup stack, say). Silence those per-site with
 * `// eslint-disable-next-line callback-set/prefer-callback-set -- <why>`.
 *
 * Only inline function-type element types match, so CallbackSet's own internal
 * `new Set<Listener<TArgs>>()` (a type *reference*) doesn't self-flag.
 */

// @typescript-eslint exposes generic args as `typeArguments` (current) and
// historically `typeParameters`; accept either so the rule survives a bump.
const TYPE_ARG_KEYS = ['typeArguments', 'typeParameters']

const typeArgsOf = (node) => {
  for (const key of TYPE_ARG_KEYS) {
    const value = node[key]
    if (value && Array.isArray(value.params)) return value
  }
  return null
}

const hasFunctionTypeParam = (typeArgs) =>
  typeArgs.params.some(param => param.type === 'TSFunctionType')

const preferCallbackSet = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer CallbackSet over a hand-rolled Set of listener callbacks.',
    },
    messages: {
      useCallbackSet:
        'A Set of function callbacks re-implements the listener add/notify/unsubscribe loop. Prefer CallbackSet from @/utils/callbackSet — it snapshots the listener set on notify and isolates listener exceptions (both easy to miss by hand). If this Set is genuinely not a listener registry, add `// eslint-disable-next-line callback-set/prefer-callback-set -- <why>`.',
    },
    schema: [],
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'useCallbackSet' })
    const check = (node) => {
      const typeArgs = typeArgsOf(node)
      if (typeArgs && hasFunctionTypeParam(typeArgs)) report(node)
    }
    return {
      // new Set<() => void>()
      "NewExpression[callee.name='Set']": check,
      // a `Set<() => void>` type annotation (field / variable / param)
      "TSTypeReference[typeName.name='Set']": check,
    }
  },
}

export default {
  rules: {
    'prefer-callback-set': preferCallbackSet,
  },
}
