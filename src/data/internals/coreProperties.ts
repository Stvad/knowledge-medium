/**
 * Kernel property schemas (data layer). Exposed as plain
 * `PropertySchema<T>` exports today; `propertySchemasFacet`
 * registration arrives with full-runtime wiring in Phase 1 stage 2 / 3.
 *
 * `aliasesProp` is the alias list parseReferences writes when a tx
 * inserts a target block (e.g. `[[Inbox]]` produces a target with
 * aliases: ['Inbox']). The same schema is consulted by alias-lookup
 * queries that resolve `[[alias]]` to a target id.
 */

import { ChangeScope, codecs, defineProperty, type PropertySchema } from '@/data/api'

/** Alias list stored on alias-target / daily-note blocks (§7). The
 *  encoded shape in `properties_json` is `string[]`; the codec is the
 *  list-of-strings combinator. */
export const aliasesProp: PropertySchema<string[]> = defineProperty<string[]>('alias', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})
