// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {lintExtensionSource} from '@/plugins/agent-runtime/extensionLint'

// These rules run on extension source at `install-extension --verify`
// time. They're advisory — the goal is to surface anti-patterns the
// agent is likely to fall into when not reading the authoring catalog
// carefully, with a pointer at the canonical alternative.
//
// We test through the public `lintExtensionSource` function rather
// than the rule internals — the rule set may grow and shrink, but the
// "did this anti-pattern surface?" question is what callers care
// about.

describe('lintExtensionSource — config-in-localstorage', () => {
  it('warns when non-credential settings go through localStorage.setItem', () => {
    const source = `
      const STATE_KEY = 'readwise:state:v1'
      window.localStorage.setItem(STATE_KEY, JSON.stringify(state))
    `
    const warnings = lintExtensionSource(source)
    expect(warnings.map(w => w.rule)).toContain('config-in-localstorage')
    const warning = warnings.find(w => w.rule === 'config-in-localstorage')!
    expect(warning.catalogPattern).toBe('user-prefs-config')
    expect(warning.message).toMatch(/getPluginPrefsBlock/)
  })

  it('also flags the shorter `localStorage.setItem(...)` form', () => {
    const source = `localStorage.setItem('readwise:autosync', JSON.stringify(true))`
    const warnings = lintExtensionSource(source)
    expect(warnings.map(w => w.rule)).toContain('config-in-localstorage')
  })

  it('does NOT flag credential-looking keys (tokens, api_keys, secrets, passwords, auth)', () => {
    // The authoring guide explicitly says credentials live in
    // localStorage. The lint must respect that.
    const cases = [
      `window.localStorage.setItem('readwise:token', token)`,
      `localStorage.setItem('readwise:api_key', key)`,
      `localStorage.setItem('readwise:apiKey', key)`,
      `localStorage.setItem('readwise:auth', auth)`,
      `localStorage.setItem('myplugin:password', pw)`,
      `localStorage.setItem('myplugin:secret-value', s)`,
      `localStorage.setItem('myplugin:credentials', c)`,
    ]
    for (const source of cases) {
      const warnings = lintExtensionSource(source)
      const configWarning = warnings.find(w => w.rule === 'config-in-localstorage')
      expect(configWarning, `should NOT flag: ${source}`).toBeUndefined()
    }
  })

  it('returns one warning per rule even if multiple lines match (avoids noise)', () => {
    const source = `
      localStorage.setItem('readwise:config:v1', JSON.stringify(c))
      localStorage.setItem('readwise:state:v1', JSON.stringify(s))
      localStorage.setItem('readwise:autosync', JSON.stringify(true))
    `
    const warnings = lintExtensionSource(source)
    const matching = warnings.filter(w => w.rule === 'config-in-localstorage')
    expect(matching).toHaveLength(1)
  })
})

describe('lintExtensionSource — stored-plugin-block-id', () => {
  it('warns when a block id is persisted in localStorage', () => {
    const source = `localStorage.setItem('readwise-root-id', root.id)`
    const warnings = lintExtensionSource(source)
    const warning = warnings.find(w => w.rule === 'stored-plugin-block-id')
    expect(warning).toBeDefined()
    expect(warning!.catalogPattern).toBe('plugin-root-singleton')
    expect(warning!.message).toMatch(/pluginBlockId/)
  })

  it('matches `rootBlockId` / `pluginId` / `blockId` substrings in the storage key', () => {
    const cases = [
      `localStorage.setItem('readwise-root-block-id', id)`,
      `localStorage.setItem('myplugin:block-id', id)`,
      `localStorage.setItem('readwise:rootId', id)`,
      `localStorage.setItem('readwise:pluginId', id)`,
    ]
    for (const source of cases) {
      const warnings = lintExtensionSource(source)
      expect(
        warnings.map(w => w.rule),
        `should warn for: ${source}`,
      ).toContain('stored-plugin-block-id')
    }
  })
})

describe('lintExtensionSource — dialog-via-window-event', () => {
  it('warns when a dialog is toggled by dispatching a window CustomEvent', () => {
    const source = `window.dispatchEvent(new CustomEvent('myplugin:toggle-settings'))`
    const warnings = lintExtensionSource(source)
    expect(warnings.map(w => w.rule)).toContain('dialog-via-window-event')
  })

  it('warns when the event name is an identifier that reads like an open intent', () => {
    const source = `handler: () => window.dispatchEvent(new CustomEvent(OPEN_EVENT)),`
    const warnings = lintExtensionSource(source)
    expect(warnings.map(w => w.rule)).toContain('dialog-via-window-event')
  })

  it('does NOT flag useSyncExternalStore — that is the blessed mechanism', () => {
    const source = `const open = useSyncExternalStore(subscribe, getSnapshot)`
    const warnings = lintExtensionSource(source)
    expect(warnings.find(w => w.rule === 'dialog-via-window-event')).toBeUndefined()
  })

  it('does NOT flag a module-scoped store declaration', () => {
    const source = `const settingsDialogStore = createStore({open: false})`
    const warnings = lintExtensionSource(source)
    expect(warnings.find(w => w.rule === 'dialog-via-window-event')).toBeUndefined()
  })

  it('does NOT flag genuine broadcast CustomEvents', () => {
    const source = `window.dispatchEvent(new CustomEvent('myplugin:data-synced', {detail}))`
    const warnings = lintExtensionSource(source)
    expect(warnings.find(w => w.rule === 'dialog-via-window-event')).toBeUndefined()
  })

  it('points at the settings-dialog catalog pattern and openDialog', () => {
    const source = `window.dispatchEvent(new CustomEvent('myplugin:open-dialog'))`
    const warning = lintExtensionSource(source).find(w => w.rule === 'dialog-via-window-event')
    expect(warning?.catalogPattern).toBe('settings-dialog')
    expect(warning?.message).toMatch(/openDialog/)
  })
})

describe('lintExtensionSource — suppression via `// lint-ok: <rule>`', () => {
  it('suppresses a specific rule when the marker is present anywhere in the source', () => {
    // The marker doesn't need to be on the same line — agents may
    // add it near the import block or as a file header to explain
    // why a deliberate exception is OK.
    const source = `
      // lint-ok: config-in-localstorage (using localStorage on purpose:
      //   device-specific debug toggle, never syncs)
      localStorage.setItem('myplugin:debug-mode', JSON.stringify(true))
    `
    const warnings = lintExtensionSource(source)
    expect(warnings.find(w => w.rule === 'config-in-localstorage')).toBeUndefined()
  })

  it('only suppresses the named rule — other warnings still fire', () => {
    const source = `
      // lint-ok: config-in-localstorage
      localStorage.setItem('myplugin:config', value)
      window.dispatchEvent(new CustomEvent('myplugin:toggle-settings'))
    `
    const warnings = lintExtensionSource(source)
    expect(warnings.find(w => w.rule === 'config-in-localstorage')).toBeUndefined()
    expect(warnings.find(w => w.rule === 'dialog-via-window-event')).toBeDefined()
  })
})

describe('lintExtensionSource — clean source', () => {
  it('returns an empty array for source using the canonical patterns', () => {
    const source = `
      import {
        ChangeScope, seedProperty, seedType,
      } from '@/data/api/index.js'
      import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
      import { getPluginPrefsBlock } from '@/data/stateBlocks.js'
      import { pluginBlockId } from '@/extensions/pluginIds.js'

      const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'
      const lastSyncProp = seedProperty({
        seedKey: extensionPropertySeedKey('lastSyncedAt'),
        revision: 1,
        name: 'readwise:lastSyncedAt',
        preset: 'optional-string',
        changeScope: ChangeScope.UserPrefs,
      })
      const readwisePrefsType = seedType({
        seedKey: extensionTypeSeedKey('prefs'),
        revision: 1,
        id: 'readwise-prefs',
        label: 'Readwise',
        properties: [lastSyncProp],
      })

      // Token is the one thing that stays in localStorage — it's a credential.
      window.localStorage.setItem('readwise:token', token)

      // Settings: prefs block.
      const prefs = await getPluginPrefsBlock(repo, repo.activeWorkspaceId, repo.user, readwisePrefsType)
      await prefs.set(lastSyncProp, new Date().toISOString())

      // Root: deterministic id.
      const rootId = pluginBlockId(repo.activeWorkspaceId, READWISE_NS, 'library-root')

      // Dialog visibility: a typed module store read via useSyncExternalStore
      // (the blessed mechanism), flipped by the configure action — not a
      // window CustomEvent.
      const open = useSyncExternalStore(subscribeSettingsOpen, () => settingsOpen)

      // Genuine broadcast (notify listeners that a sync finished) stays a CustomEvent.
      window.dispatchEvent(new CustomEvent('readwise:data-synced', {detail}))
    `
    expect(lintExtensionSource(source)).toEqual([])
  })

  it('returns an empty array for empty source', () => {
    expect(lintExtensionSource('')).toEqual([])
  })
})

describe('lintExtensionSource — output shape', () => {
  it('sorts warnings by rule id for deterministic output', () => {
    const source = `
      window.dispatchEvent(new CustomEvent('myplugin:toggle-dialog'))
      localStorage.setItem('config-blob', value)
    `
    const warnings = lintExtensionSource(source)
    const ids = warnings.map(w => w.rule)
    expect(ids).toEqual([...ids].sort())
  })

  it('truncates very long `example` snippets so verification output stays compact', () => {
    const longKey = 'a'.repeat(200)
    const source = `localStorage.setItem('${longKey}', value)`
    const warning = lintExtensionSource(source).find(w => w.rule === 'config-in-localstorage')
    if (warning?.example) {
      expect(warning.example.length).toBeLessThanOrEqual(120)
      expect(warning.example.endsWith('...')).toBe(true)
    }
  })
})
