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
 * survives invisibly and the next write lands beside it); an ENCODING change
 * either throws on the first read or silently reinterprets the stored value,
 * and which one you get depends on the codecs — `string` -> `number` throws,
 * `string-list` -> `refList` quietly decodes strings as refs.
 *
 * A REMOVAL usually does NOT lose anything, and that is the reason the retired
 * lists below exist. Once a seedKey stops being declared, its materialized
 * definition row stops being a mirror and speaks for itself — a property row
 * publishes its STORED name (`effectivePropertyDefinitionName`'s second case),
 * a type row is republished read-only under its claimed id. What that leaves
 * behind is a key that looks free and is not: a later seed claiming it reads
 * the previous seed's values as its own.
 *
 * "Usually", because a property row can only publish a usable schema while its
 * `presetId` still resolves in `repo.valuePresetCores`, which a runtime install
 * replaces wholesale. A PLUGIN-OWNED preset core leaves with its plugin, so
 * removing that plugin drops the name out of `schemas` and its cells read as
 * unset — a removal that behaves like a rename. Any seed whose preset is not a
 * kernel id is in that position. Type seeds have no such dependency, so their
 * removal is unconditional. Both branches are driven through a real workspace
 * below.
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
 * nothing here sees it. `defaultValue`, `changeScope` and `hidden` are not
 * frozen either: they are written into the definition block but nothing stored
 * is keyed or encoded by them.
 *
 * A PLUGIN-OWNED preset core is the sharper residue. Such a core is declared as
 * `definePresetCore({id: someCodec.type, build: () => someCodec})`, so both
 * frozen columns are one author-chosen string that no codec behaviour derives:
 * change what the codec parses and the ledger cannot tell. Treat that string as
 * a version and bump it. For a `json` preset the ledger freezes nothing about
 * the payload at all — its shape is a TypeScript interface out of reach here.
 *
 * Seeds declared by DB-stored runtime extensions (`agent-extensions/`) never
 * pass through this build, so their authors carry the rule themselves. The one
 * half that is machine-checked for them is the preset core: an install whose
 * core builds a different codec under an id already registered on that device
 * is refused (`@/plugins/agent-runtime/presetIdentity`, #1022), with the same
 * blind spot noted above — a codec that changes what it parses under an
 * unchanged `type` is invisible to both.
 *
 * A new seed adds a line. Any other edit is a decision about stored data: leave
 * a comment above the line saying what happened to the values, since nothing
 * else in the tree records it.
 */

/** A frozen row, filed under its `seedKey` at column 0 and carrying the STORAGE
 *  KEY — the property name, or the type id written into `typesProp` — at column
 *  1.
 *
 *  `indexBySeedKey` lifts the seedKey out into the map key, so the rows
 *  `diffSeedLedger` compares start AT the storage key. That is what lets one
 *  comparison and one retired-key check serve both kinds, and it is why every
 *  `[0]` in that function means the storage key while every `[0]` in a tuple
 *  here means the seedKey. Do not read one for the other: applying the
 *  retired-key check to a tuple's column 0 would test the seedKey, which no
 *  stored value is addressed by. */
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
  ['system:agent-dispatch-companion/property/retry-after', 'agent:retry-after', 'number', 'number'],
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
 * NOT EXHAUSTIVE, and cannot be: a key qualifies only once someone notices it.
 * The way to find more is `pnpm agent audit-properties` (plus a `types` scan for
 * ids), intersected against names git history shows were once declarations — an
 * older key that left no surviving row in the graph you scan stays invisible.
 * Add one whenever you find it.
 */

/** Property names no shipped seed may claim. Each was a declaration once. */
export const RETIRED_PROPERTY_NAMES: readonly string[] = [
  // Renamed to `backlinks:predicates` when the filter shape changed from
  // {includeIds, removeIds} to predicate arrays; stored values were dropped,
  // not converted. A remove id is ONE ancestor-scoped `referencedBy` predicate
  // only because that predicate later absorbed the page-as-tag case; at the
  // cutover the faithful mapping also needed `{scope: 'ancestor', id}`; without
  // it the exclusion matches too narrowly and formerly-removed backlinks return.
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
    renameCost: (key: string) => `cells under ${key} stop resolving and read as unset`,
    removalNote: (key: string) =>
      `the materialized definition row keeps publishing ${key} on its own, so its cells stay ` +
      'live — unless its preset core left with the same plugin, when they read as unset instead',
  },
  type: {
    fields: ['id'],
    retiredList: 'RETIRED_TYPE_IDS',
    renameCost: (key: string) => `blocks tagged ${key} silently lose the type`,
    removalNote: (key: string) =>
      `the materialized definition row is republished read-only under ${key}, so tagged blocks keep resolving`,
  },
} as const

export type SeedLedgerKind = keyof typeof LEDGER_KINDS

/** The inventory the ledger compares against, plus the ambiguities harvest
 *  resolved away — see `shippedPropertySeeds`. */
export interface ShippedPropertySeeds {
  readonly seeds: readonly AnyPropertySeedDeclaration[]
  /** Inline declarations harvest decided against, by the key they contend for. */
  readonly conflicts: ReadonlyArray<{readonly seedKey: string; readonly typeSeedKey: string}>
}

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
 * only scope PROJECTED rows, and a declaration inventory has none.
 *
 * COMPLETENESS has two conditions, and BOTH are checked rather than assumed,
 * because each is a place production RESOLVES an ambiguity it is this file's job
 * to see:
 *
 *   - the registry hands back a WINNER set of types, so a seed contested on `id`
 *     is skipped here and its inline-only properties never reach the ledger.
 *     `diffSeedLedger` refuses that contention, which is what makes one winner
 *     set equal to the union.
 *   - harvest keeps the FIRST declaration for a seed key and drops a conflicting
 *     duplicate, so the loser is invisible in its return value. `conflicts`
 *     carries those out (they cannot be recovered from `seeds` — only the
 *     winner object survives), and the caller refuses them.
 *
 * Either ambiguity therefore fails loudly instead of leaving a quiet subset. A
 * toggle profile that drops the winner is what makes a loser production's, which
 * is why the inventory cannot simply take whichever one an all-enabled build
 * happens to resolve to.
 *
 * KNOWN EXCLUSION, neither checked nor reported: a type seed inlining a FULL
 * declaration owned by a different owner is skipped by harvest as a pure ref,
 * before the conflict branch and without a warning. Nothing provides it, so it
 * materializes no definition block — and therefore nothing can WRITE through it
 * either: every typed write passes `requireWritablePropertySchema`, which throws
 * when the schema does not resolve. Reads through the handle need no registry,
 * so a value stored by some other route would still be read; such a value has no
 * definition at all, which is what `pnpm agent audit-properties` reports as an
 * unregistered key. Accepted on that basis rather than guarded, since catching
 * it here means a second copy of harvest's own-owner predicate.
 */
export const shippedPropertySeeds = (
  explicitSeeds: readonly AnyPropertySeedDeclaration[],
  typeSeeds: readonly TypeSeedDeclaration[],
  workspaceId = 'seed-ledger-inventory',
): ShippedPropertySeeds => {
  const typeDefinitions = buildTypeDefinitionRegistry({
    workspaceId, projectedDefinitions: new Map(), seeds: typeSeeds,
  })
  const conflicts: Array<{seedKey: string; typeSeedKey: string}> = []
  const harvested = harvestNestedPropertySeeds(
    typeDefinitions, explicitSeeds, conflict => conflicts.push(conflict),
  ).filter(isPropertySeedDeclaration)
  return {
    seeds: harvested.length > 0 ? [...explicitSeeds, ...harvested] : explicitSeeds,
    conflicts,
  }
}

/** Describe each dropped inline declaration in a line a reviewer can act on —
 *  the same currency `diffSeedLedger` deals in, since it is the same failure:
 *  something that can ship is not in the ledger. */
export const describeHarvestConflicts = (
  conflicts: ShippedPropertySeeds['conflicts'],
): string[] => conflicts.map(({seedKey, typeSeedKey}) =>
  `${typeSeedKey}: inlines a declaration for ${JSON.stringify(seedKey)} that another ` +
  'declaration already provides — harvest keeps the first, so this one never reaches ' +
  'the ledger and becomes production\'s under any profile that drops the winner; give ' +
  'it its own key, or inline the SAME declaration object both places').sort()

/**
 * Index rows by `seedKey`, REPORTING a duplicate rather than collapsing it.
 *
 * A bare `new Map(rows.map(...))` keeps the last row for a repeated key, which
 * would quietly undo the comparison in both directions: on the shipped side it
 * hides one of two conflicting declarations, and on the ledger side a
 * duplicated row lets an edited identity sit under a frozen original that no
 * longer matches anything.
 *
 * The duplicates come back as data rather than as a throw, because a throw here
 * is the least legible failure this file can produce: it loses `SEED_LEDGER_RULE`,
 * every other divergence, and the remedy, in a design whose whole point is that
 * each divergence arrives as a line carrying its own. Production's `indexSeeds`
 * does throw — it has to choose a winner and cannot — but this is an audit.
 */
export const indexBySeedKey = <T>(
  rows: readonly T[],
  seedKey: (row: T) => string,
  fields: (row: T) => readonly string[],
): {index: ReadonlyMap<string, readonly string[]>; duplicates: string[]} => {
  const index = new Map<string, readonly string[]>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const key = seedKey(row)
    if (index.has(key)) duplicates.add(key)
    index.set(key, fields(row))
  }
  return {index, duplicates: [...duplicates].sort()}
}

/** The frozen columns each kind compares, so a test can check the ledger's rows
 *  carry exactly that many beside their seedKey. Without it, a column added to
 *  `FrozenPropertySeed` but not to `fields` is frozen in the data and compared
 *  by nothing — the one failure a tripwire cannot afford. */
export const frozenColumnNames = (kind: SeedLedgerKind): readonly string[] =>
  LEDGER_KINDS[kind].fields

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
 * throws on them. Rename or migrate are its only answers, and a remedy that
 * offers "discard" there hands back the exact crash this file exists to
 * prevent.
 */
export const diffSeedLedger = (
  kind: SeedLedgerKind,
  shipped: ReadonlyMap<string, readonly string[]>,
  frozen: ReadonlyMap<string, readonly string[]>,
  retiredKeys: ReadonlySet<string>,
  duplicateSeedKeys: readonly string[] = [],
): string[] => {
  const {fields, retiredList, renameCost, removalNote} = LEDGER_KINDS[kind]
  const divergences: string[] = []
  const say = (subject: string, summary: string, remedy: string) =>
    divergences.push(`${subject}: ${summary} — ${remedy}`)

  for (const seedKey of duplicateSeedKeys) {
    say(seedKey, 'is declared more than once',
      'production\'s own `indexSeeds` throws on this rather than choosing; drop one ' +
      'contribution so there is a single declaration to freeze')
  }

  // Who claims each storage key NOW, and who the ledger says owned it. Column 0
  // is the storage key for both kinds. Everything below that looks at more than
  // one row at a time reads these two.
  const claimantsByKey = new Map<string, string[]>()
  for (const [seedKey, shippedFields] of shipped) {
    const key = shippedFields[0]!
    claimantsByKey.set(key, [...(claimantsByKey.get(key) ?? []), seedKey])
  }
  const frozenOwnerByKey = new Map<string, string>()
  for (const [seedKey, frozenFields] of frozen) frozenOwnerByKey.set(frozenFields[0]!, seedKey)

  /** Another seed claiming `key`. Whether a vacated key is picked up decides
   *  what happens to the data under it, so every remedy that mentions that data
   *  reads this one answer; a branch deriving it independently can contradict
   *  its neighbour in the same report. */
  const successorTo = (key: string, self: string): string | undefined =>
    claimantsByKey.get(key)?.find(claimant => claimant !== self)

  // A frozen row leaves and a shipped row arrives on its storage key with every
  // frozen column equal. TWO things look exactly like this from here and only
  // the author can tell them apart: one seed REFILED under a new seedKey (what
  // renaming a plugin does to all of its seeds at once, since `seedKeyOwner`
  // makes the owner prefix load-bearing), or a DIFFERENT seed arriving on a key
  // the other just freed. Nothing in the declarations distinguishes them — for
  // type seeds the only frozen column is the id — so this reports the fork and
  // refuses to pick, rather than inferring continuity and quietly exempting the
  // pair from the arrival, handover and removal checks that would have caught
  // the second case.
  //
  // Those three checks are still suppressed for the pair, because on the refile
  // reading they produce three wrong answers whose retire advice names a key
  // that is still shipped — which the retired-key check then refuses, leaving no
  // way to make the ledger green by following it. The one line below has to
  // carry both readings instead.
  const movedTo = new Map<string, string>()
  const movedFrom = new Map<string, string>()
  for (const [frozenSeedKey, frozenFields] of frozen) {
    if (shipped.has(frozenSeedKey)) continue
    const heir = (claimantsByKey.get(frozenFields[0]!) ?? []).find(candidate =>
      !frozen.has(candidate) && !movedFrom.has(candidate)
      && fields.every((_, index) => shipped.get(candidate)![index] === frozenFields[index]))
    if (heir === undefined) continue
    movedTo.set(frozenSeedKey, heir)
    movedFrom.set(heir, frozenSeedKey)
  }
  for (const [from, to] of movedTo) {
    const key = JSON.stringify(shipped.get(to)![0])
    say([from, to].sort().join(' + '),
      `${from} is gone and ${to} arrives on ${key} with every frozen column equal`,
      'indistinguishable from here, so decide which it is. ONE seed refiled under a new ' +
      'seedKey: nothing stored moves (the data is keyed by ' + key + ', which did not ' +
      'change), so update the row\'s seedKey — but note the deterministic definition block ' +
      'id DOES change, leaving the old row orphaned in every workspace with type rows still ' +
      `referencing it. DIFFERENT seeds: ${to} inherits what ${from} stored, so give it a ` +
      'genuinely fresh key, or MIGRATE deliberately')
  }

  for (const [key, claimants] of claimantsByKey) {
    if (claimants.length < 2) continue
    const sorted = [...claimants].sort()
    say(sorted.join(' + '), `all claim ${JSON.stringify(key)}`,
      'one storage key cannot have two owners — whichever of them a profile loads ' +
      'reads the same stored data under its own codec; namespace all but one')
  }

  for (const [seedKey, shippedFields] of shipped) {
    const storageKey = shippedFields[0]!
    // Freed in an EARLIER release and recorded; see the retired lists.
    if (retiredKeys.has(storageKey)) {
      say(seedKey, `claims ${JSON.stringify(storageKey)}, a retired storage key`,
        'the data under it is still there and this seed would inherit it; pick a ' +
        'fresh key, or MIGRATE if adopting it is the intent')
    }
    if (movedFrom.has(seedKey)) continue
    // HANDOVER — freed in THIS release, so no tombstone exists yet. Only when
    // the prior owner has actually let go: while it still claims the key this
    // is contention, reported above, and calling it a handover would be wrong.
    const priorOwner = frozenOwnerByKey.get(storageKey)
    if (priorOwner !== undefined && priorOwner !== seedKey
      && shipped.get(priorOwner)?.[0] !== storageKey) {
      say(seedKey, `takes over ${JSON.stringify(storageKey)} from ${priorOwner}`,
        'the data under it does not move with the seed that left, so this seed reads ' +
        'it as its own; retiring the key cannot help while this seed claims it — use ' +
        'a genuinely fresh key, or MIGRATE deliberately')
    }
    const frozenFields = frozen.get(seedKey)
    if (!frozenFields) {
      say(seedKey, 'ships but the ledger does not freeze it',
        `add [${[seedKey, ...shippedFields].map(v => JSON.stringify(v)).join(', ')}]`)
      continue
    }
    const successor = successorTo(frozenFields[0]!, seedKey)
    fields.forEach((field, index) => {
      const was = frozenFields[index]
      const now = shippedFields[index]
      if (was === now) return
      const summary = `${field} ${JSON.stringify(was)} -> ${JSON.stringify(now)}`
      if (index === 0) {
        // Whether the old key is LEFT BEHIND or PICKED UP changes what happens
        // to its data, so it changes the remedy.
        say(seedKey, summary, successor === undefined
          ? `${renameCost(JSON.stringify(was))}; revert, or accept the loss and add ` +
            `${JSON.stringify(was)} to ${retiredList}`
          : `${successor} now claims ${JSON.stringify(was)}, so that data is not lost — ` +
            'it is read by that seed instead; this is a handover and needs a MIGRATE ' +
            'decision, not a tombstone')
        return
      }
      const renamed = frozenFields[0] !== shippedFields[0]
      say(seedKey, summary, renamed
        ? successor === undefined
          // The rename on this same row orphaned the old cells, so nothing
          // reads them under the new encoding.
          ? 'carried by the rename on this row — the old data is abandoned, not re-read'
          : `carried by the rename on this row, but ${successor} claims the old key, so that ` +
            'data is read under ITS codec — settle the handover first'
        // NOT "throws": a widening (`string` -> `optional-string`, `ref` ->
        // `optional-ref`) decodes everything the old codec did, and is the most
        // common encoding edit there is. Asserting a throw here sent authors to
        // the two destructive remedies for the one safe case.
        : 'the key is UNCHANGED, so existing data keeps the old encoding and is read by the ' +
          'new codec — which may throw on it, silently reinterpret it, or decode it fine if ' +
          'the change only WIDENS what is accepted. Confirm which; if existing values do not ' +
          `survive, revert, or rename as well (retiring the old key into ${retiredList}), or MIGRATE`)
    })
  }
  for (const [seedKey, frozenFields] of frozen) {
    if (shipped.has(seedKey) || movedTo.has(seedKey)) continue
    const storageKey = JSON.stringify(frozenFields[0])
    const successor = successorTo(frozenFields[0]!, seedKey)
    // Removing a seed usually loses nothing — see the header. What it leaves is
    // a key that looks free, which is precisely what the retired list is for.
    say(seedKey, 'the ledger freezes it but nothing ships it', successor === undefined
      ? `${removalNote(storageKey)}; delete the row and add ${storageKey} to ` +
        `${retiredList}, or a later seed claiming ${storageKey} reads those values as its own`
      : `${successor} already claims ${storageKey}, so retiring it is not available — that ` +
        'seed reads the data this one left; settle that handover instead')
  }
  return divergences.sort()
}

/** Printed with the failing assertion. Framing only — each divergence line
 *  carries its own remedy, because they do not share one. */
export const SEED_LEDGER_RULE = [
  'A code-owned seed\'s name, preset, codec and type id are FROZEN: user data is',
  'stored UNDER them and no migration exists to move it (issue #797). Each line',
  'below says what that particular change costs and what to do about it.',
  'Reverting is usually the answer — a spelling here is a storage key that users\'',
  'data is addressed by, not a label. Updating the ledger to make this test pass,',
  'with no note and no decision, is the one move that silently loses data.',
].join('\n')
