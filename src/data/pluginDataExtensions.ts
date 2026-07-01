/**
 * Every plugin's data extension, auto-discovered from the UI-free
 * `plugins/<name>/dataExtension.ts` modules' DEFAULT export via
 * `import.meta.glob`. This is the data layer's UI-free view of all plugin
 * data — types, mutators, queries, processors, property schemas, and local
 * schema — with no hand-maintained list.
 *
 * Why it exists / why it's UI-free:
 *   - The pre-React / pre-observer local-schema DDL path (`repoProvider`,
 *     `createTestDb`) resolves `localSchemaFacet` off this WITHOUT importing
 *     the React component tree (`staticAppExtensions`). Importing the tree
 *     into `createTestDb` would add ~2s of module eval to each of the ~90
 *     test files that use it; and it must run headless / Node-safe.
 *   - It's also the basis for a future headless data runtime: ALL plugin
 *     data is resolvable here UI-free, not just schema.
 *
 * Convention & invariant: a `dataExtension.ts` is **data only** and must
 * stay graph-free — it default-exports the plugin's data `AppExtension`
 * (types / mutators / queries / processors / schemas / local schema /
 * value presets / graph-free effects) and imports NOTHING that pulls the
 * React/app graph: no components, no property-editor UI, and no actions
 * (an action handler that imports `@/utils/navigation` → React would drag
 * the whole provider graph in — measured ~1.5s/import). Those all live in
 * the plugin's `index.ts`. The Node-env `createTestDb.test` imports this
 * glob, so it fails loudly if a `dataExtension.ts` touches the DOM at
 * module-eval; keeping it data-only also keeps the import cheap.
 * `import.meta.glob` is a Vite build-time transform (confirmed in the prod
 * build; already used in `authoringCatalog.ts`), so this is not a
 * Vite-runtime dependency.
 *
 * NOTE: this is the toggle-BLIND view (local schema is provisioned
 * regardless of a plugin's enabled state). Plugin data OWNERSHIP that the
 * Repo installs (mutators / types / queries) comes from the toggle-AWARE
 * `staticAppExtensions` tree at bootstrap — NOT from here.
 */
import type { AppExtension } from '@/facets/facet.js'

const modules = import.meta.glob<AppExtension>('/src/plugins/*/dataExtension.ts', {
  eager: true,
  import: 'default',
})

export const pluginDataExtensions: readonly AppExtension[] =
  Object.entries(modules).map(([path, ext]) => {
    // A `dataExtension.ts` with no default export would otherwise vanish
    // silently from the data layer (its local schema, processors, and types
    // would simply never register) — fail loudly, naming the module instead.
    if (!ext) {
      throw new Error(
        `Data extension "${path}" has no default export — every ` +
        `plugins/<name>/dataExtension.ts must \`export default\` its data ` +
        `AppExtension.`,
      )
    }
    return ext
  })
