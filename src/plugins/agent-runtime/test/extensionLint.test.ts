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

describe('lintExtensionSource — dialog-store-instead-of-event', () => {
  it('warns when a module-scoped Dialog store is declared', () => {
    const source = `const dialogStore = createStore({ open: false })`
    const warnings = lintExtensionSource(source)
    expect(warnings.map(w => w.rule)).toContain('dialog-store-instead-of-event')
  })

  it('warns when useSyncExternalStore is used (likely subscribing to a dialog store)', () => {
    const source = `const open = useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot)`
    const warnings = lintExtensionSource(source)
    expect(warnings.map(w => w.rule)).toContain('dialog-store-instead-of-event')
  })

  it('points at the settings-dialog catalog pattern', () => {
    const source = `const settingsDialogStore = createStore({open: false})`
    const warning = lintExtensionSource(source).find(w => w.rule === 'dialog-store-instead-of-event')
    expect(warning?.catalogPattern).toBe('settings-dialog')
    expect(warning?.message).toMatch(/dispatchEvent|CustomEvent/)
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
      const dialogStore = createStore({open: false})
    `
    const warnings = lintExtensionSource(source)
    expect(warnings.find(w => w.rule === 'config-in-localstorage')).toBeUndefined()
    expect(warnings.find(w => w.rule === 'dialog-store-instead-of-event')).toBeDefined()
  })
})

describe('lintExtensionSource — clean source', () => {
  it('returns an empty array for source using the canonical patterns', () => {
    const source = `
      import {
        ChangeScope, codecs, defineBlockType, defineProperty,
        getPluginPrefsBlock, pluginBlockId, typesFacet,
      } from '@/extensions/api.js'

      const READWISE_NS = '0d4f1c2e-7e9a-4f4d-a4f1-2c0a3a6e7f01'
      const lastSyncProp = defineProperty('readwise:lastSyncedAt', {
        codec: codecs.optionalString,
        changeScope: ChangeScope.UserPrefs,
      })
      const readwisePrefsType = defineBlockType({
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

      // Dialog toggle: CustomEvent dispatch + window.addEventListener inside the component.
      window.dispatchEvent(new CustomEvent('readwise:toggle-settings'))
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
      const dialogStore = {open: false}
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
