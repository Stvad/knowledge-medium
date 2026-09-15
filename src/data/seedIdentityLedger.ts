/*
 * The FROZEN identity of every code-owned seed this build ships: a property
 * seed's stored KEY (its `name`) and stored ENCODING (its `codec.type`), and a
 * type seed's membership token (its `id`).
 *
 * All three are what user data is stored UNDER — `properties_json` keyed by
 * name, `typesProp` holding type ids verbatim — and all three are code-owned,
 * so the declaration IS the current spelling and a release that edits one
 * leaves no before-state anywhere to migrate from. Reachable in every
 * workspace today; nothing here is gated on the properties-as-blocks flip
 * (issue #797). What the three edits do to stored values, each driven through
 * a real workspace in `seedIdentityLedger.test.ts`: a RENAME reads as unset
 * (the registry pins to the declared name via
 * `effectivePropertyDefinitionName`, so the old cell survives invisibly and
 * the next write lands beside it); a CODEC change throws on the first read;
 * a REMOVAL leaves cells nothing addresses.
 *
 * This is a TRIPWIRE, not a mirror — do not generate it. Its whole value is
 * that it does NOT follow the declarations, so the diff is the one moment
 * anyone is forced to decide what happens to the values already stored. It
 * cannot migrate anything; `SEED_LEDGER_RULE` has the three ways out.
 *
 * `config` (and so `presetId`) is deliberately NOT frozen: widening one — an
 * enum option added, a `targetTypes` extended — is routine and must stay
 * cheap. Residue: NARROWING a config can make stored values undecodable under
 * an unchanged codec type, and nothing here sees it.
 *
 * Seeds declared by DB-stored runtime extensions (`agent-extensions/`) never
 * pass through this build, so their authors carry the rule themselves.
 *
 * A new seed adds a line. Any other edit is a decision about stored data:
 * leave a comment above the line saying what happened to the values, since
 * nothing else in the tree records it.
 */

/** `[seedKey, name, codecType]` — the stored key and stored encoding. */
export type FrozenPropertySeed = readonly [
  seedKey: string,
  name: string,
  codecType: string,
]

/** `[seedKey, id]` — the membership token written into `typesProp`. */
export type FrozenTypeSeed = readonly [seedKey: string, id: string]

export const FROZEN_PROPERTY_SEEDS: readonly FrozenPropertySeed[] = [
  ['system:agent-dispatch-companion/property/activity', 'agent:activity', 'string'],
  ['system:agent-dispatch-companion/property/asked-at', 'agent:asked-at', 'number'],
  ['system:agent-dispatch-companion/property/attempts', 'agent:attempts', 'number'],
  ['system:agent-dispatch-companion/property/cancel', 'agent:cancel', 'object'],
  ['system:agent-dispatch-companion/property/error', 'agent:error', 'string'],
  ['system:agent-dispatch-companion/property/executor', 'agent:executor', 'string'],
  ['system:agent-dispatch-companion/property/reply', 'agent:reply', 'boolean'],
  ['system:agent-dispatch-companion/property/resume-options', 'agent:resume-options', 'object'],
  ['system:agent-dispatch-companion/property/session', 'agent:session', 'string'],
  ['system:agent-dispatch-companion/property/status', 'agent:status', 'string'],
  ['system:agent-dispatch-companion/property/updated-at', 'agent:updated-at', 'number'],
  ['system:agent-dispatch-companion/property/watcher', 'agent:watcher', 'string'],
  ['system:agent-runtime/property/subtree-key', 'agent:subtreeKey', 'string'],
  ['system:attachments/property/media-filename', 'media:filename', 'string'],
  ['system:attachments/property/media-hash', 'media:hash', 'string'],
  ['system:attachments/property/media-mime', 'media:mime', 'string'],
  ['system:attachments/property/media-size', 'media:size', 'number'],
  ['system:backlinks-view/property/view-id', 'backlinks:viewId', 'string'],
  ['system:backlinks/property/daily-note-backlinks-predicates', 'dailyNotes:backlinksPredicates', 'backlinks:predicates'],
  ['system:backlinks/property/predicates', 'backlinks:predicates', 'backlinks:predicates'],
  ['system:block-tagging/property/tags-config', 'blockTagging:tagsConfig', 'blockTagging:tagsConfig'],
  ['system:character-counter/property/limit', 'char:limit', 'number'],
  ['system:character-counter/property/profile', 'char:profile', 'string'],
  ['system:character-counter/property/scope', 'char:scope', 'enum'],
  ['system:daily-notes/property/date', 'daily-note:date', 'date'],
  ['system:extensions-settings/property/overrides', 'extensions:overrides', 'extensions:overrides'],
  ['system:geo/property/location', 'location', 'ref'],
  ['system:geo/property/place-address', 'place:address', 'string'],
  ['system:geo/property/place-categories', 'place:categories', 'list'],
  ['system:geo/property/place-google-maps-url', 'place:googleMapsUrl', 'string'],
  ['system:geo/property/place-google-place-id', 'place:googlePlaceId', 'string'],
  ['system:geo/property/place-lat', 'place:lat', 'number'],
  ['system:geo/property/place-lng', 'place:lng', 'number'],
  ['system:geo/property/place-phone', 'place:phone', 'string'],
  ['system:geo/property/place-website', 'place:website', 'string'],
  ['system:grouped-backlinks/property/defaults', 'groupedBacklinks:defaults', 'groupedBacklinks:config'],
  ['system:grouped-backlinks/property/group-with', 'groupWith', 'refList'],
  ['system:grouped-backlinks/property/overrides', 'groupedBacklinks:overrides', 'groupedBacklinks:overrides'],
  ['system:interaction-metrics/property/interaction-record', 'interaction-metrics:record', 'object'],
  ['system:kernel-data/property/active-panel-id', 'activePanelId', 'string'],
  ['system:kernel-data/property/alias', 'alias', 'list'],
  ['system:kernel-data/property/block-selection-state', 'blockSelectionState', 'object'],
  ['system:kernel-data/property/block-type-color', 'block-type:color', 'string'],
  ['system:kernel-data/property/block-type-description', 'block-type:description', 'string'],
  ['system:kernel-data/property/block-type-hide-from-block-display', 'block-type:hide-from-block-display', 'boolean'],
  ['system:kernel-data/property/block-type-hide-from-completion', 'block-type:hide-from-completion', 'boolean'],
  ['system:kernel-data/property/block-type-label', 'block-type:label', 'string'],
  ['system:kernel-data/property/block-type-properties', 'block-type:properties', 'refList'],
  ['system:kernel-data/property/block-type-type-id', 'block-type:type-id', 'string'],
  ['system:kernel-data/property/created-at', 'createdAt', 'number'],
  ['system:kernel-data/property/editor-focus-request', 'editorFocusRequest', 'number'],
  ['system:kernel-data/property/editor-selection', 'editorSelection', 'object'],
  ['system:kernel-data/property/extension-description', 'extension:description', 'string'],
  ['system:kernel-data/property/extension-name', 'extension:name', 'string'],
  ['system:kernel-data/property/focused-block-location', 'focusedBlockLocation', 'object'],
  ['system:kernel-data/property/is-editing', 'isEditing', 'boolean'],
  ['system:kernel-data/property/migration-claimant', 'migration:claimant', 'string'],
  ['system:kernel-data/property/migration-claimed-at', 'migration:claimed-at', 'number'],
  ['system:kernel-data/property/migration-completed-at', 'migration:completed-at', 'number'],
  ['system:kernel-data/property/panel-maximized', 'panelMaximized', 'boolean'],
  ['system:kernel-data/property/panel-view-mode', 'panelViewMode', 'string'],
  ['system:kernel-data/property/property-schema-change-scope', 'property-schema:change-scope', 'enum'],
  ['system:kernel-data/property/property-schema-config', 'property-schema:config', 'object'],
  ['system:kernel-data/property/property-schema-default', 'property-schema:default', 'object'],
  ['system:kernel-data/property/property-schema-hidden', 'property-schema:hidden', 'boolean'],
  ['system:kernel-data/property/property-schema-name', 'property-schema:name', 'string'],
  ['system:kernel-data/property/property-schema-preset', 'property-schema:preset', 'string'],
  ['system:kernel-data/property/renderer', 'renderer', 'string'],
  ['system:kernel-data/property/renderer-name', 'rendererName', 'string'],
  ['system:kernel-data/property/scroll-top', 'scrollTop', 'number'],
  ['system:kernel-data/property/seed-key', 'seed:key', 'string'],
  ['system:kernel-data/property/seed-revision', 'seed:revision', 'number'],
  ['system:kernel-data/property/show-properties', 'system:showProperties', 'boolean'],
  ['system:kernel-data/property/source-block-id', 'sourceBlockId', 'string'],
  ['system:kernel-data/property/system:collapsed', 'system:collapsed', 'boolean'],
  ['system:kernel-data/property/top-level-block-id', 'topLevelBlockId', 'string'],
  ['system:kernel-data/property/types', 'types', 'list'],
  ['system:kernel-data/property/user-id', 'user:id', 'string'],
  ['system:keybindings-settings/property/overrides', 'keybindings:overrides', 'keybindings:overrides'],
  ['system:quick-find/property/recent-block-ids', 'recentBlockIds', 'list'],
  ['system:srs-rescheduling/property/archived', 'archived', 'boolean'],
  ['system:srs-rescheduling/property/factor', 'factor', 'number'],
  ['system:srs-rescheduling/property/grade', 'grade', 'number'],
  ['system:srs-rescheduling/property/interval', 'interval', 'number'],
  ['system:srs-rescheduling/property/next-review-date', 'next-review-date', 'ref'],
  ['system:srs-rescheduling/property/review-count', 'review-count', 'number'],
  ['system:srs-rescheduling/property/snapshot-history', 'snapshot-history', 'list'],
  ['system:srs-review/property/daily-note-decks', 'srs-review:daily-note-decks', 'object'],
  ['system:srs-review/property/deck-started', 'srs-review:deck-started', 'boolean'],
  ['system:srs-review/property/deck-tag', 'srs-review:deck-tag', 'string'],
  ['system:srs-review/property/progress', 'srs-review:progress', 'object'],
  ['system:startup-metrics/property/startup-record', 'startupRecord', 'object'],
  ['system:todo/property/roam-todo-state', 'roam:todo-state', 'enum'],
  ['system:todo/property/status', 'status', 'enum'],
  ['system:update-indicator/property/current-load-time', 'currentLoadTime', 'number'],
  ['system:update-indicator/property/previous-load-time', 'previousLoadTime', 'number'],
  ['system:video-player/property/notes-pane-ratio', 'video:notesPaneRatio', 'number'],
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

/** What a ledger row is called, per kind, so one divergence formatter can
 *  describe both. Adding a frozen field means adding it here and to the
 *  projection the test feeds in — not a second copy of the comparison. */
const FROZEN_FIELDS = {
  property: ['name', 'codec'],
  type: ['id'],
} as const

export type SeedLedgerKind = keyof typeof FROZEN_FIELDS

/**
 * Compare the seeds a build ships against the ledger, keyed by `seedKey`, and
 * describe every divergence in a line a reviewer can act on.
 *
 * Exact set equality in BOTH directions, because all three divergences are the
 * same hazard wearing different clothes: an unlisted seed is one whose spelling
 * nothing has frozen yet, a ledger row with no seed is data addressed by a name
 * the build stopped declaring, and a changed field is the rename or codec
 * change itself. Accepting either set difference silently would also reopen the
 * loophole the whole file exists to close — a rename spelled as one deletion
 * plus one addition.
 */
export const diffSeedLedger = (
  kind: SeedLedgerKind,
  shipped: ReadonlyMap<string, readonly string[]>,
  frozen: ReadonlyMap<string, readonly string[]>,
): string[] => {
  const fields = FROZEN_FIELDS[kind]
  const divergences: string[] = []
  for (const [seedKey, shippedFields] of shipped) {
    const frozenFields = frozen.get(seedKey)
    if (!frozenFields) {
      divergences.push(
        `${seedKey}: ships but the ledger does not freeze it — add ` +
        `[${[seedKey, ...shippedFields].map(v => JSON.stringify(v)).join(', ')}]`,
      )
      continue
    }
    fields.forEach((field, index) => {
      const was = frozenFields[index]
      const now = shippedFields[index]
      if (was !== now) {
        divergences.push(
          `${seedKey}: ${field} ${JSON.stringify(was)} -> ${JSON.stringify(now)}`,
        )
      }
    })
  }
  for (const [seedKey, frozenFields] of frozen) {
    if (shipped.has(seedKey)) continue
    divergences.push(
      `${seedKey}: the ledger freezes it but nothing ships it — ` +
      `values stored under ${JSON.stringify(frozenFields[0])} are now unaddressable`,
    )
  }
  return divergences.sort()
}

/** Printed with the failing assertion: the decision the divergence demands. */
export const SEED_LEDGER_RULE = [
  'A code-owned seed\'s name, codec and type id are FROZEN: values already',
  'stored under the old spelling/encoding do not move, and no migration exists',
  'to move them (issue #797). Pick one and say which in the PR:',
  '  1. REVERT — the spelling is a storage key that users\' data is addressed by,',
  '     not a label. This is the usual answer.',
  '  2. DISCARD — the stored values are worthless (UI state) or unconvertible',
  '     (the shape itself changed). Update the ledger line and leave a comment',
  '     above it saying so. Every property rename this repo has made was this.',
  '  3. MIGRATE — the values must be carried across. Nothing does that today;',
  '     it is a per-graph data migration that has to be built first.',
  'Updating the ledger to make this test pass, with no note and no decision, is',
  'the one move that silently loses data.',
].join('\n')
