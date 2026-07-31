import { extensionApiCatalog } from '@/extensions/apiCatalog.js'

export type AuthoringCatalogSource =
  | 'curated-api'
  | 'generated-module-glob'
  | 'html-importmap'
  | 'html-preload'
  | 'html-entry'

export interface AuthoringModuleSummary {
  importPath: string
  category: string
  description: string
  exports?: string[]
  /** Type-only exports, for curated-API modules. Surfaced for discovery and
   *  searched by the `--modules <term>` filter so a type-name lookup (e.g.
   *  `PropertyEditorProps`) finds the module that owns it. */
  types?: string[]
  source: AuthoringCatalogSource
  safeForExtensions?: boolean
}

export interface AuthoringComponentSummary {
  name: string
  importPath: string
  category: string
  description: string
  exports: string[]
  source: AuthoringCatalogSource
}

export interface AuthoringExample {
  label: string
  code: string
}

export interface AuthoringStoragePattern {
  id: string
  when: string
  use: string
  modules: string[]
  example?: AuthoringExample
}

export interface AuthoringStorageGuide {
  principles: string[]
  patterns: AuthoringStoragePattern[]
  credentials: {
    rule: string
    currentAffordance: string
    example?: AuthoringExample
  }
}

export interface AuthoringGuide {
  id: string
  title: string
  when: string[]
  principles: string[]
  steps: string[]
  preferredModules: string[]
  relatedFacets: string[]
  commands: string[]
  /** Worked code snippets that demonstrate the canonical pattern.
   *  Read these before falling back to copying from another extension —
   *  they are kept in sync with the public API surface. */
  examples?: AuthoringExample[]
  /** Notes the agent should act on *after* `install-extension`
   *  returns. Currently used to call out the disabled-by-default
   *  behaviour for user-installed extensions. */
  afterInstall?: string[]
}

export interface AuthoringCatalog {
  guides: AuthoringGuide[]
  storage: AuthoringStorageGuide
  modules: AuthoringModuleSummary[]
  components: AuthoringComponentSummary[]
}

export interface AuthoringCatalogFilters {
  guides?: string[]
  modules?: string[]
  components?: string[]
  /** When true, omit modules and components entirely. The
   *  guide-only / `--brief` path uses this to keep the response
   *  small — module/component glob dumps are 150KB of paths the
   *  agent doesn't need while reading a guide. */
  omitDiscoverableModules?: boolean
}

type RuntimeModule = Record<string, unknown>

const internalModuleIndex = import.meta.glob([
  '/src/components/**/*.{ts,tsx}',
  '/src/data/**/*.{ts,tsx}',
  '/src/extensions/**/*.{ts,tsx}',
  '/src/hooks/**/*.{ts,tsx}',
  '/src/markdown/**/*.{ts,tsx}',
  '/src/plugins/**/*.{ts,tsx}',
  '/src/shortcuts/**/*.{ts,tsx}',
  '/src/utils/**/*.{ts,tsx}',
  '!/src/**/*.test.{ts,tsx}',
  '!/src/**/test/**/*.{ts,tsx}',
])

const eagerUiModules = import.meta.glob('/src/components/ui/*.{ts,tsx}', {
  eager: true,
}) as Record<string, RuntimeModule>

const storageGuide: AuthoringStorageGuide = {
  principles: [
    'Store plugin configuration and sync state in system blocks whenever possible.',
    'Use typed properties with ChangeScope.UserPrefs for per-user preferences and ChangeScope.BlockDefault for workspace/content data.',
    'Let the platform own get-or-create for plugin-owned blocks — `getOrCreateKernelPage` for a root page, `getOrCreateTypedChild` for the records under it — so re-installs and second devices land on the existing block instead of duplicating it.',
    'Use deterministic external-id properties on imported records so sync plugins can upsert instead of duplicating data.',
    'Keep credentials in `window.localStorage`, scoped under a `knowledge-medium:<plugin>:...` key. Never echo token values through bridge output.',
  ],
  patterns: [
    {
      id: 'user-prefs-config',
      when: 'Per-user plugin settings, defaults, and lightweight sync checkpoints.',
      use: 'Define a seeded block type for the plugin via `seedType({seedKey: extensionTypeSeedKey(\'prefs\'), revision: 1, id, label, properties})` and register it through `typeSeedsFacet`. Then read/write the per-plugin sub-block via `getPluginPrefsBlock(repo, workspaceId, user, type)`. Each plugin gets its own row under user-prefs, so unrelated plugins\' settings can\'t clobber each other.',
      modules: ['@/data/api/index.js', '@/data/facets.js', '@/extensions/dynamicExtensionSeeds.js', '@/data/stateBlocks.js'],
      example: {
        label: 'Define a prefs type and read/write a setting',
        code: [
          "import { ChangeScope, seedProperty, seedType } from '@/data/api/index.js'",
          "import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'",
          "import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'",
          "import { getPluginPrefsBlock } from '@/data/stateBlocks.js'",
          "",
          "const lastSyncProp = seedProperty({",
          "  seedKey: extensionPropertySeedKey('last-synced-at'),",
          "  revision: 1,",
          "  name: 'readwise:lastSyncedAt',",
          "  preset: 'optional-string',",
          "  defaultValue: undefined,",
          "  changeScope: ChangeScope.UserPrefs,",
          "})",
          "",
          "const readwisePrefsType = seedType({",
          "  // A per-block reserved key the loader binds to this extension block",
          "  // (@extension/type/<key> → <blockId>/type/<key>). Unique within the",
          "  // extension; short, stable, never changed once shipped.",
          "  seedKey: extensionTypeSeedKey('prefs'),",
          "  revision: 1,",
          "  id: 'readwise-prefs',",
          "  label: 'Readwise',",
          "  // Prefs containers are plumbing for the # dropdown, but their",
          "  // chip is informative when the container block itself is on",
          "  // screen — hide completion only (matches the in-repo",
          "  // pluginPrefsExtension stamp).",
          "  hideFromCompletion: true,",
          "  properties: [lastSyncProp],",
          "})",
          "",
          "// In an action handler:",
          "const prefs = await getPluginPrefsBlock(repo, repo.activeWorkspaceId, repo.user, readwisePrefsType)",
          "const last = prefs.peekProperty(lastSyncProp)",
          "await prefs.set(lastSyncProp, new Date().toISOString())",
          "",
          "// Top-level facet contributions:",
          "export default [",
          "  typeSeedsFacet.of(readwisePrefsType, {source: 'readwise'}),",
          "  definitionSeedsFacet.of(lastSyncProp, {source: 'readwise'}),",
          "  // ... actions, mounts, etc.",
          "]",
        ].join('\n'),
      },
    },
    {
      id: 'plugin-root-singleton',
      when: 'The plugin needs a stable workspace-scoped root block — e.g. a "Readwise Library" page that all imported books/highlights live under.',
      use: 'Hardcode a UUID v4 once per block kind as a namespace constant, then let the platform own the get-or-create: `getOrCreateKernelPage` for the root page, `getOrCreateTypedChild` for the records under it. Both derive the block id from the namespace plus a key, so re-running the install, a fresh device, or two calls racing all land on the same block. Do NOT derive the id and then `repo.load` + `tx.create` yourself: the load answers for the moment it ran, so both writers see nothing, and the second `tx.create` throws instead of adopting.',
      modules: ['@/data/api/index.js', '@/data/kernelPage.js', '@/data/typedRecords.js'],
      example: {
        label: 'A plugin root page, and idempotent records under it',
        code: [
          "import { ChangeScope, propertyValue } from '@/data/api/index.js'",
          "import { getOrCreateKernelPage } from '@/data/kernelPage.js'",
          "import { getOrCreateTypedChild } from '@/data/typedRecords.js'",
          "",
          "// Generate ONE namespace UUID per block kind and never change it —",
          "// changing it re-points the kind at fresh ids and orphans every row",
          "// already written. (`crypto.randomUUID()` in any browser console.)",
          "const READWISE_ROOT_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'",
          "const READWISE_BOOK_NS = '3b91e4c7-5a2d-4f18-9e63-0c7a2d5b8f14'",
          "",
          "// The root page. Also repairs a row that lost its alias or type, and",
          "// restores one that was deleted — a page the plugin needs present.",
          "const root = await getOrCreateKernelPage(repo, repo.activeWorkspaceId, {",
          "  namespace: READWISE_ROOT_NS,",
          "  alias: 'Readwise Library',",
          "  markerType: 'readwise:library',   // what you subscribeBlocks({types}) for",
          "})",
          "",
          "// One block per book, under it. The key is whatever makes it THIS",
          "// book — include the workspace, since ids are global.",
          "await repo.tx(async tx => {",
          "  for (const book of books) {",
          "    const outcome = await getOrCreateTypedChild(repo, tx, {",
          "      identity: {",
          "        namespace: READWISE_BOOK_NS,",
          "        key: `${repo.activeWorkspaceId}|${book.userBookId}`,",
          "      },",
          "      parentId: root.id,",
          "      content: book.title,",
          "      types: ['readwise:book'],",
          "      properties: [propertyValue(bookIdProp, book.userBookId)],",
          "    })",
          "    // 'adopted' means the block was already there and was NOT",
          "    // overwritten — write only the fields this sync actually changed.",
          "    if (outcome.status === 'adopted') await tx.setProperty(outcome.id, progressProp, book.progress)",
          "  }",
          "}, { scope: ChangeScope.BlockDefault, description: 'sync readwise books' })",
        ].join('\n'),
      },
    },
    {
      id: 'workspace-config-block',
      when: 'Workspace-visible plugin configuration or shared sync state.',
      use: 'Use a deterministic id (see `plugin-root-singleton`) for a config block, then store config as properties and child blocks. Prefer this over user-prefs when the config should sync across all of the user\'s devices and be visible to other workspace members.',
      modules: ['@/data/api/index.js', '@/extensions/pluginIds.js'],
    },
    {
      id: 'settings-via-property-editor-override',
      when: 'Settings / configuration UI for a plugin — what a user sees when they want to change how the plugin behaves. Preferred over a modal dialog: configuration belongs *with* the block whose properties it edits, syncs naturally, and is browsable / scriptable like any other block.',
      use: 'Define a custom property editor with `definePropertyEditorOverride(propHandle, {label, Editor})` (pass the seed handle it presents) and register it via `propertyEditorOverridesFacet`. The Editor receives `PropertyEditorProps<T>` (`value`, `set`, `block`, etc.). To "open settings" from the command palette or a header item, navigate to the prefs block with `navigate(repo, {target: \'new-panel\', blockId: prefsBlock.id, workspaceId})` — the property panel renders your custom Editor inline. Reserve modal dialogs — `openDialog(Component)`, or `appMountsFacet` + a `useSyncExternalStore` visibility store — for *interactive* flows (search, picker), not for configuration.',
      modules: [
        '@/extensions/core.js', '@/shortcuts/types.js', '@/data/api/index.js',
        '@/data/facets.js', '@/extensions/dynamicExtensionSeeds.js',
        '@/data/stateBlocks.js', '@/data/properties.js', '@/utils/navigation.js',
      ],
      example: {
        label: 'Custom settings UI as a property-editor override on the prefs block',
        code: [
          "import { actionsFacet } from '@/extensions/core.js'",
          "import { ActionContextTypes } from '@/shortcuts/types.js'",
          "import {",
          "  ChangeScope, definePropertyEditorOverride, seedProperty, seedType,",
          "  type PropertyEditorProps,",
          "} from '@/data/api/index.js'",
          "import {",
          "  definitionSeedsFacet, propertyEditorOverridesFacet, typeSeedsFacet,",
          "} from '@/data/facets.js'",
          "import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'",
          "import { getPluginPrefsBlock } from '@/data/stateBlocks.js'",
          "import { showPropertiesProp } from '@/data/properties.js'",
          "import { navigate } from '@/utils/navigation.js'",
          "",
          "// 1. Each setting is its own typed property of the prefs block.",
          "//    ChangeScope.UserPrefs keeps them per-user (sync across the",
          "//    user's devices, not shared with other workspace members).",
          "const autoSyncProp = seedProperty({",
          "  seedKey: extensionPropertySeedKey('auto-sync'),",
          "  revision: 1,",
          "  name: 'readwise:autoSync',",
          "  preset: 'boolean',",
          "  defaultValue: false,",
          "  changeScope: ChangeScope.UserPrefs,",
          "})",
          "const intervalMinutesProp = seedProperty({",
          "  seedKey: extensionPropertySeedKey('interval-minutes'),",
          "  revision: 1,",
          "  name: 'readwise:intervalMinutes',",
          "  preset: 'number',",
          "  defaultValue: 60,",
          "  changeScope: ChangeScope.UserPrefs,",
          "})",
          "",
          "const readwisePrefsType = seedType({",
          "  seedKey: extensionTypeSeedKey('prefs'),",
          "  revision: 1,",
          "  id: 'readwise-prefs',",
          "  label: 'Readwise',",
          "  hideFromCompletion: true, // dropdown plumbing; chip stays informative",
          "  properties: [autoSyncProp, intervalMinutesProp],",
          "})",
          "",
          "// 2. Property-editor overrides — register one per property, each",
          "//    rendered inline in the property panel when the user opens",
          "//    the prefs block. For multi-field settings, you can either",
          "//    register multiple small editors (one per property) or have",
          "//    one editor read `block.peekProperty(other)` to span fields.",
          "const AutoSyncEditor = ({value, set}: PropertyEditorProps<boolean>) => (",
          "  <label>",
          "    <input",
          "      type='checkbox'",
          "      checked={value}",
          "      onChange={event => void set(event.target.checked)}",
          "    />",
          "    Auto-sync",
          "  </label>",
          ")",
          "",
          "const autoSyncUi = definePropertyEditorOverride(autoSyncProp, {",
          "  label: 'Auto-sync',",
          "  Editor: AutoSyncEditor,",
          "})",
          "",
          "// 3. The 'open settings' action navigates to the prefs block;",
          "//    the property panel renders the Editor inline. No modal.",
          "const openSettings = {",
          "  id: 'readwise.configure',",
          "  description: 'Configure Readwise sync',",
          "  context: ActionContextTypes.GLOBAL,",
          "  handler: async ({uiStateBlock}) => {",
          "    const repo = uiStateBlock.repo",
          "    const workspaceId = repo.activeWorkspaceId",
          "    if (!workspaceId) return",
          "    const prefsBlock = await getPluginPrefsBlock(",
          "      repo, workspaceId, repo.user, readwisePrefsType,",
          "    )",
          "    // Force the property panel visible on arrival — the block's",
          "    // own content is usually empty (everything is in properties).",
          "    await prefsBlock.set(showPropertiesProp, true)",
          "    navigate(repo, {target: 'new-panel', blockId: prefsBlock.id, workspaceId})",
          "  },",
          "}",
          "",
          "// 4. Wire the contributions.",
          "export default [",
          "  typeSeedsFacet.of(readwisePrefsType, {source: 'readwise'}),",
          "  definitionSeedsFacet.of(autoSyncProp, {source: 'readwise'}),",
          "  definitionSeedsFacet.of(intervalMinutesProp, {source: 'readwise'}),",
          "  propertyEditorOverridesFacet.of(autoSyncUi, {source: 'readwise'}),",
          "  actionsFacet.of(openSettings, {source: 'readwise'}),",
          "]",
        ].join('\n'),
      },
    },
    {
      id: 'imported-record-blocks',
      when: 'External records such as Readwise books/highlights that should be queryable and editable as blocks.',
      use: 'Define source-id properties (`readwise:user_book_id`, `readwise:highlight_id`, …), then let `getOrCreateTypedChild` own the write: give it a `{namespace, key}` built from the external id and it creates on the first sync and adopts on every one after, so re-syncing updates the existing block instead of duplicating it. Do NOT pin a derived id onto a bare `tx.create` — that throws `DuplicateIdError` the second time round and takes the whole transaction with it.',
      modules: ['@/data/api/index.js', '@/data/kernelPage.js', '@/data/typedRecords.js'],
      example: {
        label: 'Idempotent record sync, and the tx primitives underneath it',
        code: [
          "import { ChangeScope, propertyValue } from '@/data/api/index.js'",
          "import { getOrCreateKernelPage } from '@/data/kernelPage.js'",
          "import { getOrCreateTypedChild } from '@/data/typedRecords.js'",
          "",
          "// Inside `await repo.tx(async tx => { ... }, {scope, description})`:",
          "//",
          "//   tx.get(id)                       → Promise<BlockData | null>",
          "//   tx.peek(id)                      → BlockData | null (sync, snapshot read)",
          "//   tx.create({...})                 → Promise<string> (new id)",
          "//   tx.update(id, patch)             → patch is {content?, properties?, references?}",
          "//   tx.delete(id) / tx.restore(id)   → soft delete + recover",
          "//   tx.move(id, {parentId, orderKey})",
          "//   tx.childrenOf(parentId, wsId?)   → Promise<BlockData[]> (order_key ascending)",
          "//   tx.parentOf(childId)             → Promise<BlockData | null>",
          "",
          "const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'",
          "",
          "const root = await getOrCreateKernelPage(repo, repo.activeWorkspaceId, {",
          "  namespace: READWISE_NS,",
          "  alias: 'Readwise Library',",
          "  markerType: 'readwise:library',",
          "})",
          "",
          "await repo.tx(async tx => {",
          "  for (const hl of highlights) {",
          "    const outcome = await getOrCreateTypedChild(repo, tx, {",
          "      // Whatever makes this THIS highlight. Include the workspace:",
          "      // block ids are global, and two workspaces deriving one id",
          "      // collide.",
          "      identity: {",
          "        namespace: READWISE_NS,",
          "        key: `${repo.activeWorkspaceId}|hl:${hl.id}`,",
          "      },",
          "      parentId: root.id,          // appended last; no order-key maths",
          "      content: hl.text,",
          "      types: ['readwise:highlight'],",
          "      properties: [propertyValue(highlightIdProp, String(hl.id))],",
          "    })",
          "",
          "    // 'created' → written from the spec above.",
          "    // 'adopted' → it was already there and was NOT overwritten; the",
          "    //             user's own edits to this block survive a re-sync.",
          "    //             Write only what this sync actually changes.",
          "    // 'taken'   → the id holds something you can't use (deleted, or",
          "    //             another workspace's row). Nothing was written.",
          "    if (outcome.status === 'adopted' && hl.note) {",
          "      await tx.setProperty(outcome.id, noteProp, hl.note)",
          "    }",
          "  }",
          "}, { scope: ChangeScope.BlockDefault, description: 'readwise sync' })",
        ].join('\n'),
      },
    },
  ],
  credentials: {
    rule: 'Store credentials in `window.localStorage` under a `knowledge-medium:<plugin>:token:v1`-style key. Block-backed storage isn\'t appropriate for secrets because PowerSync ships block content to the server.',
    currentAffordance: 'Render a setup Dialog that links to the provider\'s token page, validate the token against the provider\'s auth endpoint before saving, then write it to localStorage. Never include token values in action return payloads or bridge eval output.',
    example: {
      label: 'localStorage credential read/write',
      code: [
        "const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'",
        "",
        "const loadToken = () => window.localStorage.getItem(TOKEN_KEY) || null",
        "const saveToken = (t) => window.localStorage.setItem(TOKEN_KEY, t)",
        "const clearToken = () => window.localStorage.removeItem(TOKEN_KEY)",
        "",
        "// Validate before saving so a typo doesn't get silently stored:",
        "const ok = await fetch('https://readwise.io/api/v2/auth/', {",
        "  headers: { Authorization: `Token ${candidate}` },",
        "}).then(r => r.status === 204)",
        "if (ok) saveToken(candidate)",
      ].join('\n'),
    },
  },
}

const settingsDialogExample: AuthoringExample = {
  label: 'Setup dialog mounted via appMountsFacet; visibility is a typed module store flipped by an action',
  code: [
    "import { actionsFacet, appMountsFacet } from '@/extensions/core.js'",
    "import { ActionContextTypes } from '@/shortcuts/types.js'",
    "import { useRepo } from '@/context/repo.js'",
    "import { showError, showSuccess } from '@/utils/toast.js'",
    "import {",
    "  Dialog, DialogContent, DialogDescription, DialogFooter,",
    "  DialogHeader, DialogTitle,",
    "} from '@/components/ui/dialog.js'",
    "import { Button } from '@/components/ui/button.js'",
    "import { Input } from '@/components/ui/input.js'",
    "import { Label } from '@/components/ui/label.js'",
    "import { useState, useSyncExternalStore } from 'react'",
    "",
    "const TOKEN_KEY = 'knowledge-medium:readwise:token:v1'",
    "",
    "// Visibility is a tiny typed module store — NOT a window CustomEvent.",
    "// The configure action flips it directly; the mounted component reads",
    "// it with useSyncExternalStore, the same mechanism the app's own",
    "// DialogHost uses. (For a one-shot prompt that just returns a value,",
    "// prefer the imperative `openDialog(Component)` shape below instead.)",
    "let settingsOpen = false",
    "const settingsListeners = new Set()",
    "const setSettingsOpen = next => {",
    "  settingsOpen = next",
    "  settingsListeners.forEach(notify => notify())",
    "}",
    "const subscribeSettingsOpen = notify => {",
    "  settingsListeners.add(notify)",
    "  return () => settingsListeners.delete(notify)",
    "}",
    "",
    "const ReadwiseSetupDialog = () => {",
    "  const repo = useRepo()  // access Repo from inside an appMountsFacet component",
    "  const open = useSyncExternalStore(subscribeSettingsOpen, () => settingsOpen)",
    "  const [token, setToken] = useState('')",
    "  const [saving, setSaving] = useState(false)",
    "",
    "  const save = async () => {",
    "    setSaving(true)",
    "    try {",
    "      const ok = await fetch('https://readwise.io/api/v2/auth/', {",
    "        headers: { Authorization: `Token ${token}` },",
    "      }).then(r => r.status === 204).catch(() => false)",
    "      if (!ok) {",
    "        showError('Readwise rejected that token. Check it and try again.')",
    "        return",
    "      }",
    "      window.localStorage.setItem(TOKEN_KEY, token)",
    "      // repo is available here if you need to write workspace state too.",
    "      void repo  // (silence unused — show the access pattern)",
    "      showSuccess('Readwise connected.')",
    "      setSettingsOpen(false)",
    "    } finally {",
    "      setSaving(false)",
    "    }",
    "  }",
    "",
    "  return (",
    "    <Dialog open={open} onOpenChange={setSettingsOpen}>",
    "      <DialogContent>",
    "        <DialogHeader>",
    "          <DialogTitle>Connect Readwise</DialogTitle>",
    "          <DialogDescription>",
    "            Get a token from readwise.io/access_token and paste it here.",
    "          </DialogDescription>",
    "        </DialogHeader>",
    "        <Label htmlFor='rw-token'>Access token</Label>",
    "        <Input",
    "          id='rw-token'",
    "          value={token}",
    "          onChange={e => setToken(e.target.value)}",
    "          disabled={saving}",
    "        />",
    "        <DialogFooter>",
    "          <Button onClick={save} disabled={!token || saving}>",
    "            {saving ? 'Validating…' : 'Save'}",
    "          </Button>",
    "        </DialogFooter>",
    "      </DialogContent>",
    "    </Dialog>",
    "  )",
    "}",
    "",
    "export default [",
    "  appMountsFacet.of(",
    "    { id: 'readwise.setup-dialog', component: ReadwiseSetupDialog },",
    "    { source: 'readwise' },",
    "  ),",
    "  actionsFacet.of({",
    "    id: 'user.readwise.configure',",
    "    description: 'Configure Readwise',",
    "    context: ActionContextTypes.GLOBAL,",
    "    handler: () => setSettingsOpen(true),",
    "  }, { source: 'readwise' }),",
    "]",
  ].join('\n'),
}

const openDialogExample: AuthoringExample = {
  label: 'Simpler alternative: imperative `openDialog` from an action handler',
  code: [
    "// When you just need a one-shot prompt (no persistent mount, no",
    "// reactive subscription), `openDialog(Component, props)` returns",
    "// a promise that resolves with the user's choice. The dialog",
    "// component receives `resolve(value)` and `cancel()` as props.",
    "import { actionsFacet } from '@/extensions/core.js'",
    "import { ActionContextTypes } from '@/shortcuts/types.js'",
    "import { openDialog } from '@/utils/dialogs.js'",
    "import { showError, showSuccess } from '@/utils/toast.js'",
    "import {",
    "  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,",
    "} from '@/components/ui/dialog.js'",
    "import { Button } from '@/components/ui/button.js'",
    "import { Input } from '@/components/ui/input.js'",
    "import { useState } from 'react'",
    "",
    "const ReadwiseTokenPrompt = ({ resolve, cancel }) => {",
    "  const [token, setToken] = useState('')",
    "  return (",
    "    <Dialog open={true} onOpenChange={open => { if (!open) cancel() }}>",
    "      <DialogContent>",
    "        <DialogHeader><DialogTitle>Paste your Readwise token</DialogTitle></DialogHeader>",
    "        <Input value={token} onChange={e => setToken(e.target.value)} />",
    "        <DialogFooter>",
    "          <Button onClick={() => resolve(token)} disabled={!token}>Save</Button>",
    "        </DialogFooter>",
    "      </DialogContent>",
    "    </Dialog>",
    "  )",
    "}",
    "",
    "actionsFacet.of({",
    "  id: 'user.readwise.configure',",
    "  description: 'Configure Readwise',",
    "  context: ActionContextTypes.GLOBAL,",
    "  handler: async () => {",
    "    const token = await openDialog(ReadwiseTokenPrompt)",
    "    if (!token) return  // user cancelled",
    "    const ok = await fetch('https://readwise.io/api/v2/auth/', {",
    "      headers: { Authorization: `Token ${token}` },",
    "    }).then(r => r.status === 204).catch(() => false)",
    "    if (!ok) { showError('Readwise rejected that token.'); return }",
    "    window.localStorage.setItem('knowledge-medium:readwise:token:v1', token)",
    "    showSuccess('Readwise connected.')",
    "  },",
    "}, { source: 'readwise' })",
  ].join('\n'),
}

const guides: AuthoringGuide[] = [
  {
    id: 'external-sync-plugin',
    title: 'External Sync Plugin',
    when: ['imports external API data', 'needs setup/config', 'needs manual sync'],
    principles: [
      'Use block-backed config and sync checkpoints.',
      'Use a Dialog mounted through appMountsFacet for setup — never window.prompt/alert/confirm.',
      'Store credentials in window.localStorage; everything else (settings, checkpoints, imported data) lives in blocks.',
      'Use stable external ids on imported records, or derive their block ids deterministically with uuidv5, so re-syncs upsert instead of duplicating.',
    ],
    steps: [
      'Define typed properties for external ids and source metadata via `seedProperty` + `definitionSeedsFacet`. Persist sync checkpoints on a `getPluginPrefsBlock` sub-block, not localStorage.',
      'Render a Dialog component, mount it via `appMountsFacet`, and drive its open/closed state from a small typed module store the component reads with `useSyncExternalStore`. The configure action flips that store directly — never a `window` CustomEvent. Validate credentials against the provider\'s auth endpoint before saving. (For one-shot prompts, `openDialog(Component)` is the simpler imperative alternative — see the settings-dialog guide.)',
      'Add a manual sync action through `actionsFacet`. The handler reads the checkpoint from the prefs block, fetches incremental updates, and runs a single `repo.tx`. Wrap the body in `showProgress(...)` so the user sees per-page / per-book progress and a final summary.',
      'Anchor imported content under a plugin-owned root page created with `getOrCreateKernelPage` — see the `plugin-root-singleton` storage pattern.',
      'Upsert child records the same way: derive the block id from the external id, or look up by an external-id property. Never create a second block for the same external record.',
      'For *background* sync (poll a webhook / poll on an interval) use `appEffectsFacet.of({id, start: ({repo}) => { ... return cleanup })`. Manual sync via an action is enough for most plugins — only reach for an effect when the data source itself pushes. The effect object must be a STABLE reference: define it once at module scope (not inline in a function-valued extension), and export your extension as an array, not a function — a fresh `{id, start}` every resolve reads as "code changed" and silently restarts the effect (dropping its connection / interval) on every unrelated extension toggle.',
    ],
    preferredModules: [
      '@/extensions/core.js',
      '@/shortcuts/types.js',
      // Data primitives the steps require (seedProperty, definitionSeedsFacet,
      // getPluginPrefsBlock, pluginBlockId, extensionPropertySeedKey). In brief
      // mode preferredModules is the ONLY module hint, so these must be here.
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/data/stateBlocks.js',
      '@/extensions/dynamicExtensionSeeds.js',
      '@/extensions/pluginIds.js',
      '@/context/repo.js',
      '@/utils/dialogs.js',
      '@/utils/toast.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.actions', 'core.app-mounts', 'core.app-effects', 'data.definition-seeds', 'data.types'],
    commands: [
      'pnpm agent describe-runtime --guide external-sync-plugin --storage',
      'pnpm agent describe-runtime --components dialog,input,button,label',
      // Writes compiled declarations for the app's vendored `@/...`
      // modules, so TS-aware editors resolve extension imports with
      // the same signatures the app build checks.
      'pnpm agent types agent-extensions/kernel-types',
      'pnpm agent types --module "@/data/api/index.js"',
      // Convention: extension source files live under `agent-extensions/`
      // at the repo root. The matrix-chat-client + canvas-layout
      // extensions are there as references.
      'pnpm agent install-extension --verify [--description "<text>"] agent-extensions/<plugin>.js <label>',
      'pnpm agent enable-extension <label>',
      'pnpm agent uninstall-extension <label>',
    ],
    afterInstall: [
      'User-installed extensions are disabled by default (`userExtensionToggle` sets `defaultEnabled: false`). After install, run `pnpm agent enable-extension <label>` (or `<id>`) before its actions show up in `pnpm agent run-action`.',
      'enable-extension does two things (issue #67): it sets the synced "enabled" intent AND grants THIS device a trust approval pinned to the current source hash. A block runs only with both — so enabling on the bridge runs it on the bridge.',
      'After you EDIT an extension (install-extension onto the same block, or hand-edit the source), re-run `pnpm agent enable-extension <label>` to re-pin the new source on this device. Until you do, the device keeps running the PREVIOUSLY approved version and the settings UI shows "Update available" — the live source is never auto-executed.',
      'disable-extension / a source change do NOT stop a running extension by themselves: disable only clears intent (the trust grant persists for a frictionless re-enable), and a drifted source keeps running the pinned version. uninstall-extension deletes the block and revokes the device trust.',
      'Do not retry `install-extension` if the action is "not found" — the install succeeded; the toggle/approval is just off. Run enable-extension.',
      'Pass `--verify` to `install-extension` to see the facets/actions the extension contributed without enabling/approving it (verify compiles the live source in isolation for diagnostics only).',
    ],
    examples: [
      settingsDialogExample,
      openDialogExample,
    ],
  },
  {
    id: 'settings-dialog',
    title: 'Settings Dialog',
    when: ['needs user setup', 'needs explanatory text', 'needs form controls'],
    principles: [
      'For *configuration* UI, prefer the `settings-via-property-editor-override` storage pattern: register a `definePropertyEditorOverride` and navigate to the prefs block. The property panel renders your editor inline — settings live with the block they edit, sync naturally, and are scriptable like any other block. Modal dialogs are right for interactive flows (search, picker, credential setup) — they\'re wrong as the default for "user changes how the plugin behaves".',
      'Two equally-valid dialog shapes: (a) appMountsFacet + a typed module store the component reads via `useSyncExternalStore`, flipped by an action, for a persistent mount that can react to live state; (b) imperative `openDialog(Component, props)` from an action handler when you just need a one-shot prompt that returns a value. Never route dialog open/toggle through a `window` CustomEvent — that bypasses the typed action and dialog channels.',
      'Access the live Repo from inside a Dialog component with `useRepo()`. Action handlers receive it as `uiStateBlock.repo`.',
      'Use system dialog and form components (`Dialog`, `Input`, `Button`, `Label`) — they already match the app theme.',
      'Use `showError` / `showSuccess` / `showProgress` for feedback. Never `window.alert` / `window.confirm` / `window.prompt`.',
      'Validate credentials against the provider\'s auth endpoint before persisting.',
    ],
    steps: [
      'Check first whether this is *configuration*. If so, use the `settings-via-property-editor-override` pattern instead — modal dialog is the wrong shape for configuration.',
      'For a non-configuration flow, pick the shape: (a) appMountsFacet + a typed module store read via `useSyncExternalStore` (flipped by an action) if the dialog will live across the session and react to live state; (b) `openDialog(Component)` from the action handler when "open it, get a value, close it" is all you need.',
      'Build the dialog with `Dialog` + `DialogContent` + form controls. Access repo via `useRepo()` (mount-style) or via the action handler\'s `uiStateBlock.repo` before calling `openDialog`.',
      'Report progress / outcome via `showProgress` / `showSuccess` / `showError`.',
      'Save non-secret values via `getPluginPrefsBlock`; save credentials to `localStorage`.',
    ],
    preferredModules: [
      '@/extensions/core.js',
      '@/shortcuts/types.js',
      // The property-editor-override path + saving non-secret settings need
      // these (definePropertyEditorOverride, propertyEditorOverridesFacet,
      // getPluginPrefsBlock); brief mode surfaces only preferredModules.
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/data/stateBlocks.js',
      '@/context/repo.js',
      '@/utils/dialogs.js',
      '@/utils/toast.js',
      '@/components/ui/dialog.js',
      '@/components/ui/input.js',
      '@/components/ui/button.js',
      '@/components/ui/label.js',
    ],
    relatedFacets: ['core.app-mounts', 'core.actions'],
    commands: [
      'pnpm agent describe-runtime --components dialog,input,button,label',
      'pnpm agent describe-runtime --modules components/ui',
      'pnpm agent types agent-extensions/kernel-types',
      'pnpm agent types --module "@/components/ui/dialog.js"',
    ],
    examples: [
      settingsDialogExample,
      openDialogExample,
    ],
  },
  {
    id: 'block-backed-config',
    title: 'Block-Backed Config',
    when: ['stores settings', 'stores sync state', 'stores imported metadata'],
    principles: storageGuide.principles,
    steps: [
      'Choose UserPrefs for per-user settings and BlockDefault for shared workspace/content data.',
      'Define properties with stable seed keys and value presets, then register them through `definitionSeedsFacet`.',
      'For per-plugin sub-blocks under user-prefs, define a seeded block type via `seedType({seedKey: extensionTypeSeedKey(key), revision, id, label, properties})` and read/write via `getPluginPrefsBlock(repo, workspaceId, user, type)`.',
      'For plugin-owned singleton blocks (e.g. import roots), reach for `getOrCreateKernelPage` — it derives the id from the workspace and handles the create, the repair and the restore, so re-installs land on the same block.',
      'Store large or user-visible imported data as child/content blocks.',
    ],
    preferredModules: [
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/extensions/dynamicExtensionSeeds.js',
      '@/data/stateBlocks.js',
      '@/extensions/pluginIds.js',
    ],
    relatedFacets: ['data.definition-seeds', 'data.types'],
    commands: [
      'pnpm agent describe-runtime --storage',
      'pnpm agent describe-runtime --facets data.definition-seeds',
      'pnpm agent types agent-extensions/kernel-types',
      'pnpm agent types --module "@/data/api/index.js"',
    ],
    examples: [
      storageGuide.patterns.find(p => p.id === 'user-prefs-config')!.example!,
      storageGuide.patterns.find(p => p.id === 'plugin-root-singleton')!.example!,
    ],
  },
  {
    id: 'record-grain',
    title: 'Record Grain — what becomes a block, what becomes a property',
    when: [
      'designs a data model',
      'stores records, entries, logs, or history',
      'points at another block',
      'declares types or properties',
      'wonders whether to reuse an existing type',
    ],
    principles: [
      'A block is the unit of everything this app gives you for free: SQL queries, references and backlinks, undo, sync, hand-editing in the outline, rendering. Anything you would want to see, link to, undo, or edit on its own is its own block — not a row inside a JSON cell.',
      'Properties hold the scalar facts ABOUT a block. A property whose value is a list of records is a cell nothing can see into: not queryable, not referenceable, and clobbered wholesale by a concurrent write.',
      'Anything that points at another block is a `ref` / `optional-ref` / `refList` property with `config: {targetTypes: [...]}` — never a bare id string, never a name. Refs project into real references, so the target\'s backlinks answer "what points at me", and the link survives renaming or moving the target.',
      'Identity is a block id; a name is a label the user will change. Never join records on a name.',
      'Compose before inventing. If a concept already has a type (todo, page, daily note), add that type to your block alongside your own instead of re-declaring its fields.',
      'Type ids and property names are global. Prefix both with your extension (`myext-set`, `myext:weight`); a bare noun collides with whatever else claims it, and the loser silently gets the other schema.',
      'Type the blocks you READ too, not just the ones you write. A typed block in the user\'s own notes gets property editors, and lets your parser read a declaration instead of guessing at prose.',
      'The test for a good record: uninstall the extension, and the data still reads as a sensible outline.',
      'If a record has a natural identity, derive its block id from that identity (`getOrCreateTypedChild`) instead of minting a random one. "Query for it, then create if absent" cannot be made correct — the query answers for the moment it ran, so a UI gesture that fires before it resolves, a bootstrap that runs twice, or a second device all create a duplicate. Deriving the id makes the writers converge on one row instead of racing.',
    ],
    steps: [
      'Sketch the tree first: which block is the parent, what is one record, what hangs off it. One record per block, ordered by `order_key` under its parent.',
      'Declare a namespaced type per record kind (`seedType`) and namespaced properties (`seedProperty`), registered through `typeSeedsFacet` / `definitionSeedsFacet`.',
      'Pick presets by meaning: scalars (`number`, `string`, `date`, `strict-enum`), pointers (`ref` / `optional-ref` / `refList` with `targetTypes`), scalar lists (`string-list`). Reach for `json` only for an opaque config object you will never query into.',
      'Write records with `createTypedChild(repo, tx, {...})` — create, type-tag, and typed properties in one call inside your transaction. When the record has a natural identity and you do not control when the write fires, use `getOrCreateTypedChild` with a `{namespace, key}` identity instead, and it becomes idempotent: repeat it and it adopts what it finds rather than duplicating it.',
      'Compose built-ins by listing them in `types`: `[MY_TYPE, TODO_TYPE]` plus the todo `statusProp` gives a real checkbox instead of a private done flag.',
      'Read back with a typed block query over your type id, and let backlinks answer the reverse direction instead of maintaining your own index.',
      'After installing, run `kmagent audit-extension <label>`: it reads the blocks you actually wrote and flags block ids parked in string properties, records buried in JSON, and properties written with no registered schema. (Inside the app repo the same CLI is `pnpm agent …`.)',
    ],
    preferredModules: [
      '@/data/typedRecords.js',
      '@/data/api/index.js',
      '@/data/facets.js',
      '@/extensions/dynamicExtensionSeeds.js',
      '@/plugins/todo/schema.js',
      '@/data/orderKey.js',
    ],
    relatedFacets: ['data.definition-seeds', 'data.types'],
    commands: [
      'kmagent new-extension "<Name>"',
      'kmagent data-model',
      'kmagent describe-runtime --guide record-grain',
      'kmagent audit-extension <label>',
      'kmagent backlinks <blockId>',
    ],
    examples: [
      {
        label: 'A record per block: typed, composed with todo, linked back to its definition',
        code: [
          "import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api/index.js'",
          "import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'",
          "import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'",
          "import { createTypedChild } from '@/data/typedRecords.js'",
          "import { TODO_TYPE, statusProp as todoStatusProp } from '@/plugins/todo/schema.js'",
          "",
          "const SET_TYPE = 'strength-set'          // namespaced: a bare `set` would collide",
          "",
          "const weightProp = seedProperty({",
          "  seedKey: extensionPropertySeedKey('set-weight'),",
          "  revision: 1,",
          "  name: 'strength:weight',               // namespaced too",
          "  preset: 'number',",
          "  defaultValue: 0,",
          "  changeScope: ChangeScope.BlockDefault,",
          "})",
          "",
          "// A pointer to another block is a REF, not a string: the target's",
          "// backlinks then show every record that points at it.",
          "const definitionProp = seedProperty({",
          "  seedKey: extensionPropertySeedKey('definition'),",
          "  revision: 1,",
          "  name: 'strength:definition',",
          "  preset: 'optional-ref',",
          "  config: {targetTypes: ['strength-exercise-def']},",
          "  defaultValue: undefined,",
          "  changeScope: ChangeScope.BlockDefault,",
          "})",
          "",
          "const setType = seedType({",
          "  seedKey: extensionTypeSeedKey('set'),",
          "  revision: 1,",
          "  id: SET_TYPE,",
          "  label: 'Set',",
          "  properties: [weightProp, definitionProp],",
          "})",
          "",
          "export default [",
          "  definitionSeedsFacet.of(weightProp, {source: 'strength'}),",
          "  definitionSeedsFacet.of(definitionProp, {source: 'strength'}),",
          "  typeSeedsFacet.of(setType, {source: 'strength'}),",
          "]",
          "",
          "// One block per set — NOT a `sets: [...]` JSON property on the parent.",
          "// Each set is queryable, referenceable, undoable, hand-editable.",
          "export const logSets = async (repo, exerciseId, definitionId, sets) => {",
          "  await repo.tx(async tx => {",
          "    const snapshot = repo.snapshotTypeRegistries()",
          "    for (const set of sets) {",
          "      await createTypedChild(repo, tx, {",
          "        parentId: exerciseId,",
          "        content: `${set.weight}lb × ${set.reps}`,   // readable even without the extension",
          "        types: [SET_TYPE, TODO_TYPE],                // compose: done-ness belongs to todo",
          "        properties: [",
          "          propertyValue(weightProp, set.weight),",
          "          propertyValue(definitionProp, definitionId),",
          "          propertyValue(todoStatusProp, set.done ? 'done' : 'open'),",
          "        ],",
          "        typeSnapshot: snapshot,",
          "      })",
          "    }",
          "  }, {scope: ChangeScope.BlockDefault, description: 'Log sets'})",
          "}",
        ].join('\n'),
      },
    ],
  },
]

const normalizeTerms = (filters: string[] | undefined): string[] =>
  (filters ?? [])
    .flatMap(filter => filter.split(','))
    .map(filter => filter.trim().toLowerCase())
    .filter(Boolean)

const matchesTerms = (
  filters: string[] | undefined,
  ...values: Array<string | string[] | undefined>
): boolean => {
  const terms = normalizeTerms(filters)
  if (terms.length === 0) return true

  const haystack = values
    .flatMap(value => Array.isArray(value) ? value : value ? [value] : [])
    .map(value => value.toLowerCase())

  return terms.some(term =>
    haystack.some(value => value === term || value.includes(term)),
  )
}

const sourcePriority = (source: AuthoringCatalogSource): number => {
  if (source === 'curated-api') return 4
  if (source === 'generated-module-glob') return 3
  if (source === 'html-entry') return 2
  if (source === 'html-preload') return 1
  return 0
}

const stripExtension = (path: string): string =>
  path.replace(/\.(ts|tsx|js|jsx|mjs)$/, '')

const toImportPath = (path: string): string =>
  stripExtension(path)
    .replace(/^\/src\//, '@/')
    .replace(/^src\//, '@/')
    .replace(/$/, '.js')

const basename = (path: string): string =>
  stripExtension(path).split('/').at(-1) ?? path

const categoryForPath = (importPath: string): string => {
  if (importPath.includes('/components/ui/')) return 'ui-component'
  if (importPath.includes('/components/')) return 'component'
  if (importPath.includes('/extensions/')) return 'extension-system'
  if (importPath.includes('/plugins/')) return 'plugin'
  if (importPath.includes('/data/')) return 'data'
  if (importPath.startsWith('react') || importPath.includes('/node_modules/')) return 'external'
  return 'module'
}

const generatedDescription = (exports: string[] | undefined): string => {
  if (exports && exports.length > 0) {
    return `Generated from the module graph; runtime exports: ${exports.slice(0, 8).join(', ')}.`
  }
  return 'Generated from the module graph; export names are not loaded for this module.'
}

const moduleDescriptionForPath = (source: AuthoringCatalogSource): string => {
  if (source === 'html-importmap') return 'Import-map entry visible to dynamic extension modules.'
  if (source === 'html-entry') return 'Module entry script loaded by the current app document.'
  if (source === 'html-preload') return 'Module preload discovered from the current app document.'
  return 'Generated from the module graph.'
}

const exportNames = (module: RuntimeModule | undefined): string[] | undefined => {
  if (!module) return undefined
  return Object.keys(module).sort()
}

const eagerUiExportMap = (): Map<string, string[]> => {
  const map = new Map<string, string[]>()
  for (const [path, module] of Object.entries(eagerUiModules)) {
    map.set(toImportPath(path), exportNames(module) ?? [])
  }
  return map
}

// The curated public extension API (`apiCatalog.ts`) surfaced as authoring
// modules: real importPath, curated category + description, and the blessed
// runtime export names. These outrank the raw module-glob entries (see
// `sourcePriority`), so where both describe the same path the curated
// description/category wins on merge; curated-only paths (`@/facets/*`,
// `@/context/*`, `@/paste/*`, `@/types.js`) are added outright.
const curatedApiModules = (): AuthoringModuleSummary[] =>
  extensionApiCatalog.map(group => ({
    importPath: group.importPath,
    category: group.category,
    description: group.description,
    ...(group.exports.length > 0 ? {exports: group.exports} : {}),
    ...(group.types.length > 0 ? {types: group.types} : {}),
    source: 'curated-api',
    safeForExtensions: true,
  } satisfies AuthoringModuleSummary))

const generatedModules = (): AuthoringModuleSummary[] => {
  const eagerExports = eagerUiExportMap()
  const globModules = Object.keys(internalModuleIndex).map(path => {
    const importPath = toImportPath(path)
    const exports = eagerExports.get(importPath)
    return {
      importPath,
      category: categoryForPath(importPath),
      description: generatedDescription(exports),
      ...(exports ? {exports} : {}),
      source: 'generated-module-glob',
      safeForExtensions: true,
    } satisfies AuthoringModuleSummary
  })
  return [...globModules, ...curatedApiModules()]
}

const isComponentExport = (name: string): boolean =>
  /^[A-Z]/.test(name)

const generatedComponents = (): AuthoringComponentSummary[] => {
  const out: AuthoringComponentSummary[] = []
  const seen = new Set<string>()

  const push = (component: AuthoringComponentSummary) => {
    const key = `${component.importPath}:${component.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(component)
  }

  for (const [path, module] of Object.entries(eagerUiModules)) {
    const importPath = toImportPath(path)
    for (const name of exportNames(module)?.filter(isComponentExport) ?? []) {
      push({
        name,
        importPath,
        category: categoryForPath(importPath),
        description: `Generated from runtime export ${name}.`,
        exports: [name],
        source: 'generated-module-glob',
      })
    }
  }

  for (const path of Object.keys(internalModuleIndex)) {
    if (!path.endsWith('.tsx')) continue
    const name = basename(path)
    if (!isComponentExport(name)) continue
    const importPath = toImportPath(path)
    push({
      name,
      importPath,
      category: categoryForPath(importPath),
      description: `Inferred from component module ${importPath}.`,
      exports: [name],
      source: 'generated-module-glob',
    })
  }

  return out.sort((a, b) =>
    a.importPath.localeCompare(b.importPath) || a.name.localeCompare(b.name),
  )
}

const normalizeDocumentModulePath = (raw: string, baseURI: string | undefined): string => {
  try {
    const url = new URL(raw, baseURI || 'http://agent-runtime.local/')
    const pathname = url.pathname
    const srcIndex = pathname.indexOf('/src/')
    if (srcIndex >= 0) return `@/${stripExtension(pathname.slice(srcIndex + '/src/'.length))}.js`
    const nodeIndex = pathname.indexOf('/node_modules/')
    if (nodeIndex >= 0) return pathname.slice(nodeIndex + 1)
    return pathname || raw
  } catch {
    return raw
  }
}

const importMapModules = (document: Document): AuthoringModuleSummary[] => {
  const modules: AuthoringModuleSummary[] = []
  const scripts = Array.from(document.querySelectorAll('script[type="importmap"]'))

  for (const script of scripts) {
    const text = script.textContent?.trim()
    if (!text) continue

    try {
      const parsed = JSON.parse(text) as {imports?: Record<string, string>}
      for (const [key, value] of Object.entries(parsed.imports ?? {})) {
        modules.push({
          importPath: key,
          category: key.startsWith('@/') || key === '@/' ? 'extension-import-prefix' : 'external',
          description: `${moduleDescriptionForPath('html-importmap')} Target: ${value}`,
          source: 'html-importmap',
          safeForExtensions: key === '@/' || key.startsWith('react'),
        })
      }
    } catch {
      modules.push({
        importPath: '<invalid importmap>',
        category: 'diagnostic',
        description: 'The current document has an importmap script that could not be parsed as JSON.',
        source: 'html-importmap',
      })
    }
  }

  return modules
}

const linkedModules = (
  document: Document,
  selector: string,
  source: AuthoringCatalogSource,
): AuthoringModuleSummary[] =>
  Array.from(document.querySelectorAll(selector))
    .map(element => element.getAttribute('href') ?? element.getAttribute('src') ?? '')
    .filter(Boolean)
    .map(raw => {
      const importPath = normalizeDocumentModulePath(raw, document.baseURI)
      return {
        importPath,
        category: categoryForPath(importPath),
        description: moduleDescriptionForPath(source),
        source,
        safeForExtensions: importPath.startsWith('@/'),
      }
    })

const documentModules = (document: Document | undefined): AuthoringModuleSummary[] => {
  if (!document) return []
  return [
    ...importMapModules(document),
    ...linkedModules(document, 'link[rel="modulepreload"][href]', 'html-preload'),
    ...linkedModules(document, 'script[type="module"][src]', 'html-entry'),
  ]
}

const mergeModules = (modules: AuthoringModuleSummary[]): AuthoringModuleSummary[] => {
  const seen = new Map<string, AuthoringModuleSummary>()
  for (const module of modules) {
    const existing = seen.get(module.importPath)
    if (!existing || sourcePriority(module.source) > sourcePriority(existing.source)) {
      seen.set(module.importPath, module)
    }
  }
  return [...seen.values()].sort((a, b) => a.importPath.localeCompare(b.importPath))
}

export const describeAuthoringCatalog = (
  filters: AuthoringCatalogFilters = {},
  document?: Document,
): AuthoringCatalog => {
  const modules = filters.omitDiscoverableModules
    ? []
    : mergeModules([
      ...generatedModules(),
      ...documentModules(document),
    ]).filter(module =>
      matchesTerms(filters.modules, module.importPath, module.category, module.description, module.exports, module.types),
    )

  const components = filters.omitDiscoverableModules
    ? []
    : generatedComponents().filter(component =>
      matchesTerms(filters.components, component.name, component.importPath, component.category, component.description, component.exports),
    )

  return {
    guides: guides.filter(guide =>
      matchesTerms(filters.guides, guide.id, guide.title, guide.when, guide.relatedFacets),
    ),
    storage: storageGuide,
    modules,
    components,
  }
}
