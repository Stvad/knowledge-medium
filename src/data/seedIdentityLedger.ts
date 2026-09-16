/*
 * The FROZEN identity of every code-owned seed this build ships: a property
 * seed's stored KEY (its `name`) and stored ENCODING (its `presetId` +
 * `codec.type`), and a type seed's membership token (its `id`).
 *
 * All of those are what user data is stored UNDER — `properties_json` keyed by
 * name, `typesProp` holding type ids verbatim — and all are code-owned, so the
 * declaration IS the current spelling and a release that edits one leaves no
 * before-state anywhere to migrate from. Reachable in every workspace today;
 * nothing here is gated on the properties-as-blocks flip (issue #797). What the
 * edits do to stored values, the first two driven through a real workspace in
 * `seedIdentityLedger.test.ts`: a RENAME reads as unset (the registry pins to
 * the declared name via `effectivePropertyDefinitionName`, so the old cell
 * survives invisibly and the next write lands beside it); a CODEC change throws
 * on the first read; a REMOVAL leaves cells nothing addresses.
 *
 * ENCODING takes two columns because neither subsumes the other. `presetId`
 * alone would miss a codec whose `type` string moved under a stable preset id.
 * `codec.type` alone would miss the sharper case: an optional preset and its
 * required twin SHARE a discriminator (`optional-string` and `string` are both
 * `'string'`, `optional-ref` and `ref` both `'ref'`) while the optional one
 * WRITES `null` for unset — which the required codec's decode throws on. One
 * word changed in a declaration, and every cell a user left empty throws.
 *
 * This is a TRIPWIRE, not a mirror — do not generate it. Its whole value is
 * that it does NOT follow the declarations, so the diff is the one moment
 * anyone is forced to decide what happens to the values already stored. It
 * cannot migrate anything; `SEED_LEDGER_RULE` has the three ways out.
 *
 * `config` is deliberately NOT frozen: widening one — an enum option added, a
 * `targetTypes` extended — is routine and must stay cheap. Residue: NARROWING a
 * config can make stored values undecodable under an unchanged preset, and
 * nothing here sees it.
 *
 * Seeds declared by DB-stored runtime extensions (`agent-extensions/`) never
 * pass through this build, so their authors carry the rule themselves.
 *
 * A new seed adds a line. Any other edit is a decision about stored data: leave
 * a comment above the line saying what happened to the values, since nothing
 * else in the tree records it.
 */

/** A frozen row. Column 0 is always the STORAGE KEY — the property name, or the
 *  type id written into `typesProp` — which is what makes one comparison and
 *  one retired-key check serve both kinds. */
export type FrozenPropertySeed = readonly [
  seedKey: string,
  name: string,
  presetId: string,
  codecType: string,
]

export type FrozenTypeSeed = readonly [seedKey: string, id: string]

export const FROZEN_PROPERTY_SEEDS: readonly FrozenPropertySeed[] = [
  ['system:agent-dispatch-companion/property/activity', 'agent:activity', 'string', 'string'],
  ['system:agent-dispatch-companion/property/asked-at', 'agent:asked-at', 'number', 'number'],
  ['system:agent-dispatch-companion/property/attempts', 'agent:attempts', 'number', 'number'],
  ['system:agent-dispatch-companion/property/cancel', 'agent:cancel', 'raw-json', 'object'],
  ['system:agent-dispatch-companion/property/error', 'agent:error', 'string', 'string'],
  ['system:agent-dispatch-companion/property/executor', 'agent:executor', 'string', 'string'],
  ['system:agent-dispatch-companion/property/reply', 'agent:reply', 'boolean', 'boolean'],
  ['system:agent-dispatch-companion/property/resume-options', 'agent:resume-options', 'optional-json', 'object'],
  ['system:agent-dispatch-companion/property/session', 'agent:session', 'string', 'string'],
  ['system:agent-dispatch-companion/property/status', 'agent:status', 'string', 'string'],
  ['system:agent-dispatch-companion/property/updated-at', 'agent:updated-at', 'number', 'number'],
  ['system:agent-dispatch-companion/property/watcher', 'agent:watcher', 'string', 'string'],
  ['system:agent-runtime/property/subtree-key', 'agent:subtreeKey', 'string', 'string'],
  ['system:attachments/property/media-filename', 'media:filename', 'optional-string', 'string'],
  ['system:attachments/property/media-hash', 'media:hash', 'string', 'string'],
  ['system:attachments/property/media-mime', 'media:mime', 'string', 'string'],
  ['system:attachments/property/media-size', 'media:size', 'number', 'number'],
  ['system:backlinks-view/property/view-id', 'backlinks:viewId', 'optional-string', 'string'],
  ['system:backlinks/property/daily-note-backlinks-predicates', 'dailyNotes:backlinksPredicates', 'backlinks:predicates', 'backlinks:predicates'],
  ['system:backlinks/property/predicates', 'backlinks:predicates', 'backlinks:predicates', 'backlinks:predicates'],
  ['system:block-tagging/property/tags-config', 'blockTagging:tagsConfig', 'blockTagging:tagsConfig', 'blockTagging:tagsConfig'],
  ['system:character-counter/property/limit', 'char:limit', 'optional-number', 'number'],
  ['system:character-counter/property/profile', 'char:profile', 'optional-string', 'string'],
  ['system:character-counter/property/scope', 'char:scope', 'strict-enum', 'enum'],
  ['system:daily-notes/property/date', 'daily-note:date', 'date', 'date'],
  ['system:extensions-settings/property/overrides', 'extensions:overrides', 'extensions:overrides', 'extensions:overrides'],
  ['system:geo/property/location', 'location', 'optional-ref', 'ref'],
  ['system:geo/property/place-address', 'place:address', 'optional-string', 'string'],
  ['system:geo/property/place-categories', 'place:categories', 'string-list', 'list'],
  ['system:geo/property/place-google-maps-url', 'place:googleMapsUrl', 'optional-string', 'string'],
  ['system:geo/property/place-google-place-id', 'place:googlePlaceId', 'optional-string', 'string'],
  ['system:geo/property/place-lat', 'place:lat', 'optional-number', 'number'],
  ['system:geo/property/place-lng', 'place:lng', 'optional-number', 'number'],
  ['system:geo/property/place-phone', 'place:phone', 'optional-string', 'string'],
  ['system:geo/property/place-website', 'place:website', 'optional-string', 'string'],
  ['system:grouped-backlinks/property/defaults', 'groupedBacklinks:defaults', 'groupedBacklinks:config', 'groupedBacklinks:config'],
  ['system:grouped-backlinks/property/group-with', 'groupWith', 'refList', 'refList'],
  ['system:grouped-backlinks/property/overrides', 'groupedBacklinks:overrides', 'groupedBacklinks:overrides', 'groupedBacklinks:overrides'],
  ['system:interaction-metrics/property/interaction-record', 'interaction-metrics:record', 'optional-json', 'object'],
  ['system:kernel-data/property/active-panel-id', 'activePanelId', 'optional-string', 'string'],
  ['system:kernel-data/property/alias', 'alias', 'string-list', 'list'],
  ['system:kernel-data/property/block-selection-state', 'blockSelectionState', 'json', 'object'],
  ['system:kernel-data/property/block-type-color', 'block-type:color', 'string', 'string'],
  ['system:kernel-data/property/block-type-description', 'block-type:description', 'string', 'string'],
  ['system:kernel-data/property/block-type-hide-from-block-display', 'block-type:hide-from-block-display', 'boolean', 'boolean'],
  ['system:kernel-data/property/block-type-hide-from-completion', 'block-type:hide-from-completion', 'boolean', 'boolean'],
  ['system:kernel-data/property/block-type-label', 'block-type:label', 'string', 'string'],
  ['system:kernel-data/property/block-type-properties', 'block-type:properties', 'refList', 'refList'],
  ['system:kernel-data/property/block-type-type-id', 'block-type:type-id', 'string', 'string'],
  ['system:kernel-data/property/created-at', 'createdAt', 'optional-number', 'number'],
  ['system:kernel-data/property/editor-focus-request', 'editorFocusRequest', 'number', 'number'],
  ['system:kernel-data/property/editor-selection', 'editorSelection', 'optional-json', 'object'],
  ['system:kernel-data/property/extension-description', 'extension:description', 'string', 'string'],
  ['system:kernel-data/property/extension-name', 'extension:name', 'string', 'string'],
  ['system:kernel-data/property/focused-block-location', 'focusedBlockLocation', 'optional-json', 'object'],
  ['system:kernel-data/property/is-editing', 'isEditing', 'boolean', 'boolean'],
  ['system:kernel-data/property/migration-claimant', 'migration:claimant', 'string', 'string'],
  ['system:kernel-data/property/migration-claimed-at', 'migration:claimed-at', 'number', 'number'],
  ['system:kernel-data/property/migration-completed-at', 'migration:completed-at', 'optional-number', 'number'],
  ['system:kernel-data/property/panel-maximized', 'panelMaximized', 'boolean', 'boolean'],
  ['system:kernel-data/property/panel-view-mode', 'panelViewMode', 'optional-string', 'string'],
  ['system:kernel-data/property/property-schema-change-scope', 'property-schema:change-scope', 'strict-enum', 'enum'],
  ['system:kernel-data/property/property-schema-config', 'property-schema:config', 'json', 'object'],
  ['system:kernel-data/property/property-schema-default', 'property-schema:default', 'raw-json', 'object'],
  ['system:kernel-data/property/property-schema-hidden', 'property-schema:hidden', 'boolean', 'boolean'],
  ['system:kernel-data/property/property-schema-name', 'property-schema:name', 'string', 'string'],
  ['system:kernel-data/property/property-schema-preset', 'property-schema:preset', 'string', 'string'],
  ['system:kernel-data/property/renderer', 'renderer', 'optional-string', 'string'],
  ['system:kernel-data/property/renderer-name', 'rendererName', 'optional-string', 'string'],
  ['system:kernel-data/property/scroll-top', 'scrollTop', 'optional-number', 'number'],
  ['system:kernel-data/property/seed-key', 'seed:key', 'string', 'string'],
  ['system:kernel-data/property/seed-revision', 'seed:revision', 'number', 'number'],
  ['system:kernel-data/property/show-properties', 'system:showProperties', 'boolean', 'boolean'],
  ['system:kernel-data/property/source-block-id', 'sourceBlockId', 'optional-string', 'string'],
  ['system:kernel-data/property/system:collapsed', 'system:collapsed', 'boolean', 'boolean'],
  ['system:kernel-data/property/top-level-block-id', 'topLevelBlockId', 'optional-string', 'string'],
  ['system:kernel-data/property/types', 'types', 'string-list', 'list'],
  ['system:kernel-data/property/user-id', 'user:id', 'string', 'string'],
  ['system:keybindings-settings/property/overrides', 'keybindings:overrides', 'keybindings:overrides', 'keybindings:overrides'],
  ['system:quick-find/property/recent-block-ids', 'recentBlockIds', 'string-list', 'list'],
  ['system:srs-rescheduling/property/archived', 'archived', 'boolean', 'boolean'],
  ['system:srs-rescheduling/property/factor', 'factor', 'number', 'number'],
  ['system:srs-rescheduling/property/grade', 'grade', 'number', 'number'],
  ['system:srs-rescheduling/property/interval', 'interval', 'number', 'number'],
  ['system:srs-rescheduling/property/next-review-date', 'next-review-date', 'ref', 'ref'],
  ['system:srs-rescheduling/property/review-count', 'review-count', 'number', 'number'],
  ['system:srs-rescheduling/property/snapshot-history', 'snapshot-history', 'list', 'list'],
  ['system:srs-review/property/daily-note-decks', 'srs-review:daily-note-decks', 'json', 'object'],
  ['system:srs-review/property/deck-started', 'srs-review:deck-started', 'boolean', 'boolean'],
  ['system:srs-review/property/deck-tag', 'srs-review:deck-tag', 'string', 'string'],
  ['system:srs-review/property/progress', 'srs-review:progress', 'json', 'object'],
  ['system:startup-metrics/property/startup-record', 'startupRecord', 'optional-json', 'object'],
  ['system:todo/property/roam-todo-state', 'roam:todo-state', 'strict-enum', 'enum'],
  ['system:todo/property/status', 'status', 'strict-enum', 'enum'],
  ['system:update-indicator/property/current-load-time', 'currentLoadTime', 'optional-number', 'number'],
  ['system:update-indicator/property/previous-load-time', 'previousLoadTime', 'optional-number', 'number'],
  ['system:video-player/property/notes-pane-ratio', 'video:notesPaneRatio', 'number', 'number'],
]

export const FROZEN_TYPE_SEEDS: readonly FrozenTypeSeed[] = [
  ['system:attachments/type/assets', 'assets'],
  ['system:attachments/type/media', 'media'],
  ['system:backlinks/type/backlinks-prefs', 'backlinks-prefs'],
  ['system:block-tagging/type/block-tagging-prefs', 'block-tagging-prefs'],
  ['system:character-counter/type/char-counter', 'char-counter'],
  ['system:daily-notes/type/daily-note', 'daily-note'],
  ['system:extensions-settings/type/extensions-prefs', 'extensions-prefs'],
  ['system:geo/type/map', 'map'],
  ['system:geo/type/place', 'place'],
  ['system:grouped-backlinks/type/grouped-backlinks-prefs', 'grouped-backlinks-prefs'],
  ['system:interaction-metrics/type/interaction-metrics', 'interaction-metrics'],
  ['system:interaction-metrics/type/interaction-record', 'interaction-metrics-record'],
  ['system:kernel-data/type/block-type', 'block-type'],
  ['system:kernel-data/type/extension', 'extension'],
  ['system:kernel-data/type/page', 'page'],
  ['system:kernel-data/type/panel', 'panel'],
  ['system:kernel-data/type/panel-stack', 'panel-stack'],
  ['system:kernel-data/type/panel:migrations', 'panel:migrations'],
  ['system:kernel-data/type/panel:properties', 'panel:properties'],
  ['system:kernel-data/type/panel:recents', 'panel:recents'],
  ['system:kernel-data/type/panel:types', 'panel:types'],
  ['system:kernel-data/type/property-schema', 'property-schema'],
  ['system:kernel-data/type/system:migration-claim', 'system:migration-claim'],
  ['system:kernel-data/type/user', 'user'],
  ['system:keybindings-settings/type/keybindings-prefs', 'keybindings-prefs'],
  ['system:quick-find/type/quick-find-ui-state', 'quick-find-ui-state'],
  ['system:srs-rescheduling/type/srs-sm2.5', 'srs-sm2.5'],
  ['system:srs-review/type/srs-review-deck', 'srs-review-deck'],
  ['system:srs-review/type/srs-review-prefs', 'srs-review-prefs'],
  ['system:srs-review/type/srs-review-progress', 'srs-review-progress'],
  ['system:startup-metrics/type/startup-metrics', 'startup-metrics'],
  ['system:startup-metrics/type/startup-record', 'startup-metrics-record'],
  ['system:todo/type/todo', 'todo'],
  ['system:update-indicator/type/update-indicator-prefs', 'update-indicator-prefs'],
]

/*
 * Storage keys this build no longer declares, and that stored data is still
 * addressed by. A key leaves the active ledger two ways — a seed is REMOVED, or
 * a seed is RENAMED off it — and neither deletes one cell or one type tag. Both
 * land here.
 *
 * Without this, the active ledger alone cannot tell a rename from a removal plus
 * an unrelated new seed, and a freed key is worse than merely forgotten: a LATER
 * seed, under any seedKey, may claim it and silently adopt the orphaned values —
 * resurrected under new semantics, or thrown on at the first decode under an
 * incompatible codec. So a shipped seed claiming a key listed here is a
 * divergence, not a fresh start. Reclaiming one deliberately (you want the old
 * values, under the old key) is the MIGRATE answer, not a line deletion.
 *
 * Note these are keyed by the STORAGE key, not by `seedKey` — which is why a
 * name retired before seeds existed still belongs here. Its seedKey is
 * irrelevant; the cells are keyed by the name.
 *
 * COMPLETENESS BOUND, so nobody reads the list as exhaustive: it was seeded from
 * the keys a live workspace actually holds orphaned data under (`pnpm agent
 * audit-properties`, plus a `types` scan) intersected with names git history
 * shows were once shipped declarations. An older name that left no surviving row
 * in that graph is not here. Add one when you find it.
 */

/** Property names no shipped seed may claim. Each was a declaration once. */
export const RETIRED_PROPERTY_NAMES: readonly string[] = [
  // Renamed to `backlinks:predicates` when the filter shape changed from
  // {includeIds, removeIds} to predicate arrays; values were not convertible
  // and were discarded deliberately.
  'backlinks:filter',
  // Same change, the daily-note defaults half: renamed to
  // `dailyNotes:backlinksPredicates`.
  'dailyNotes:backlinksDefaults',
  // Retired when focus moved to a rendered location (`focusedBlockLocation`):
  // an unscoped block id could not say WHICH rendering held the cursor.
  'focusedBlockId',
  // Retired with the same render-scope migration.
  'focusedVisualTargetKey',
  // `extensionDisabledProp` — extension enablement moved to the overrides map.
  'system:disabled',
  // Retired when the pane view mode (`panelViewModeProp`) took over selecting
  // the video-notes renderer; a per-block flag could not express it.
  'video:playerView',
]

/** Type ids no shipped seed may claim — a block tagged with one keeps the tag
 *  forever, so reusing an id silently re-types someone else's blocks. */
export const RETIRED_TYPE_IDS: readonly string[] = [
  // Per-block view selection replaced the prefs block.
  'backlinks-view-prefs',
  // Generalized into the user-applicable `map` type.
  'panel:locations',
  // `USER_PREFS_TYPE` — preferences moved onto per-plugin sub-blocks.
  'user-prefs',
]

import {isPropertySeedDeclaration, type AnyPropertySeedDeclaration} from '@/data/propertySeeds'
import type {TypeSeedDeclaration} from '@/data/typeSeeds'
import {buildTypeDefinitionRegistry, harvestNestedPropertySeeds} from '@/data/typeDefinitionRegistry'

/** Everything that differs between the two kinds: the columns a row carries,
 *  the retired list that governs its storage key, and what losing that key
 *  actually costs a user. One table, so a remedy cannot be written for property
 *  seeds and forgotten for type seeds. */
const LEDGER_KINDS = {
  property: {
    fields: ['name', 'preset', 'codec'],
    retiredList: 'RETIRED_PROPERTY_NAMES',
    cost: (key: string) => `cells under ${key} stop resolving and read as unset`,
  },
  type: {
    fields: ['id'],
    retiredList: 'RETIRED_TYPE_IDS',
    cost: (key: string) => `blocks tagged ${key} silently lose the type`,
  },
} as const

export type SeedLedgerKind = keyof typeof LEDGER_KINDS

/**
 * The property seeds a build ships, composed the way `facetBridge`'s
 * `propertySchemas` step composes them — NOT as a raw `definitionSeedsFacet`
 * read.
 *
 * The difference is `harvestNestedPropertySeeds`: a type seed may declare a
 * property inline in its `properties` without contributing it separately, and
 * that property materializes a backing block and stores user data like any
 * other. Reading the facet alone would leave exactly those outside the ledger,
 * silently — the one class of seed nothing else would ever freeze.
 *
 * `projectedDefinitions` is empty and the workspace id is a placeholder: both
 * only scope PROJECTED rows, and a declaration inventory has none. What the
 * registry contributes here is its winner set, so a type seed contested on `id`
 * is skipped — the same seeds production would decline to materialize.
 */
export const shippedPropertySeeds = (
  explicitSeeds: readonly AnyPropertySeedDeclaration[],
  typeSeeds: readonly TypeSeedDeclaration[],
  workspaceId = 'seed-ledger-inventory',
): readonly AnyPropertySeedDeclaration[] => {
  const typeDefinitions = buildTypeDefinitionRegistry({
    workspaceId, projectedDefinitions: new Map(), seeds: typeSeeds,
  })
  const harvested = harvestNestedPropertySeeds(typeDefinitions, explicitSeeds)
    .filter(isPropertySeedDeclaration)
  return harvested.length > 0 ? [...explicitSeeds, ...harvested] : explicitSeeds
}

/**
 * Index rows by `seedKey`, REFUSING a duplicate rather than collapsing it.
 *
 * A bare `new Map(rows.map(...))` keeps the last row for a repeated key, which
 * would quietly undo the comparison in both directions: on the shipped side it
 * hides one of two conflicting declarations, and on the ledger side a
 * duplicated row lets an edited identity sit under a frozen original that no
 * longer matches anything. `indexSeeds` throws on a duplicate seed key for the
 * same reason; so does this.
 */
export const indexBySeedKey = <T>(
  label: string,
  rows: readonly T[],
  seedKey: (row: T) => string,
  fields: (row: T) => readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const indexed = new Map<string, readonly string[]>()
  for (const row of rows) {
    const key = seedKey(row)
    if (indexed.has(key)) {
      throw new Error(`[seed ledger] duplicate ${label} seed key ${JSON.stringify(key)}`)
    }
    indexed.set(key, fields(row))
  }
  return indexed
}

/**
 * Compare the seeds a build ships against the ledger, keyed by `seedKey`, and
 * describe every divergence as a line carrying its OWN remedy.
 *
 * Exact set equality in BOTH directions, because all three divergences are the
 * same hazard wearing different clothes: an unlisted seed is one whose spelling
 * nothing has frozen yet, a ledger row with no seed is data addressed by a key
 * the build stopped declaring, and a changed field is the rename or encoding
 * change itself. Accepting either set difference silently would also reopen the
 * loophole the file exists to close — a rename spelled as one deletion plus one
 * addition. `retiredKeys` closes what set equality cannot see: a storage key an
 * earlier removal or rename freed, which a new seed would otherwise inherit
 * along with its orphaned values.
 *
 * The remedy belongs on the LINE and not in one blanket instruction, because
 * the four divergences do not share one. In particular an ENCODING change at an
 * UNCHANGED name cannot be discarded at all: nothing is abandoned, the existing
 * cells keep the old representation under the same key, and the new codec
 * throws on them — the exact crash this file exists to prevent, reachable by
 * following a "discard" instruction to the letter. Rename or migrate are its
 * only answers. A blanket instruction said "discard" to it for one round.
 */
export const diffSeedLedger = (
  kind: SeedLedgerKind,
  shipped: ReadonlyMap<string, readonly string[]>,
  frozen: ReadonlyMap<string, readonly string[]>,
  retiredKeys: ReadonlySet<string>,
): string[] => {
  const {fields, retiredList, cost} = LEDGER_KINDS[kind]
  const divergences: string[] = []
  const say = (seedKey: string, summary: string, remedy: string) =>
    divergences.push(`${seedKey}: ${summary} — ${remedy}`)
  for (const [seedKey, shippedFields] of shipped) {
    // Column 0 is the storage key for both kinds, so this one check covers a
    // reclaimed property name and a reclaimed type id alike.
    const storageKey = shippedFields[0]!
    if (retiredKeys.has(storageKey)) {
      say(seedKey, `claims ${JSON.stringify(storageKey)}, a retired storage key`,
        'the data under it is still there and this seed would inherit it; pick a ' +
        'fresh key, or MIGRATE if adopting it is the intent')
    }
    const frozenFields = frozen.get(seedKey)
    if (!frozenFields) {
      say(seedKey, 'ships but the ledger does not freeze it',
        `add [${[seedKey, ...shippedFields].map(v => JSON.stringify(v)).join(', ')}]`)
      continue
    }
    const renamed = frozenFields[0] !== shippedFields[0]
    fields.forEach((field, index) => {
      const was = frozenFields[index]
      const now = shippedFields[index]
      if (was === now) return
      const summary = `${field} ${JSON.stringify(was)} -> ${JSON.stringify(now)}`
      if (index === 0) {
        say(seedKey, summary,
          `${cost(JSON.stringify(was))}; revert, or accept the loss and add ` +
          `${JSON.stringify(was)} to ${retiredList}`)
        return
      }
      say(seedKey, summary, renamed
        // The rename on this same row already orphaned the old cells, so
        // nothing reads them under the new encoding.
        ? 'carried by the rename on this row — the old data is abandoned, not re-read'
        : 'the key is UNCHANGED, so existing data keeps the old encoding and the new ' +
          'codec throws on it; discard is not available here — rename as well ' +
          `(retiring the old key into ${retiredList}), or MIGRATE`)
    })
  }
  for (const [seedKey, frozenFields] of frozen) {
    if (shipped.has(seedKey)) continue
    const storageKey = JSON.stringify(frozenFields[0])
    say(seedKey, 'the ledger freezes it but nothing ships it',
      `${cost(storageKey)}; delete the row and add ${storageKey} to ${retiredList}`)
  }
  return divergences.sort()
}

/** Printed with the failing assertion. Framing only — each divergence line
 *  carries its own remedy, because they do not share one. */
export const SEED_LEDGER_RULE = [
  'A code-owned seed\'s name, preset, codec and type id are FROZEN: user data is',
  'stored UNDER them and no migration exists to move it (issue #797). Each line',
  'above says what that particular change costs and what to do about it.',
  'Reverting is usually the answer — a spelling here is a storage key that users\'',
  'data is addressed by, not a label. Updating the ledger to make this test pass,',
  'with no note and no decision, is the one move that silently loses data.',
].join('\n')
