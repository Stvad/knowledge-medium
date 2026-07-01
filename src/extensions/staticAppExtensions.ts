import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.js'
import { toastAppMountExtension } from '@/extensions/toastAppMount.js'
import { appUpdatePromptExtension } from '@/extensions/appUpdateMount.js'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions.js'
import {
  defaultActionContextsExtension,
  defaultActionsExtension,
} from '@/shortcuts/defaultShortcuts.js'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi.js'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets.js'

// Core (non-plugin) extensions — the kernel data registries + app-shell
// surfaces that live under `@/data`, `@/extensions`, `@/shortcuts`, and
// `@/components` rather than `src/plugins/`. Explicit list, kept FIRST so
// plugin contributions (globbed below) can override the defaults via the
// facets' last-wins/precedence ordering.
const coreExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  // kernelDataExtension contributes KERNEL_MUTATORS and core data
  // registries. repo.setFacetRuntime REPLACES those registries, so the
  // kernel contribution must be present in every static runtime.
  kernelDataExtension,
  kernelPropertyUiExtension,
  kernelValuePresetsExtension,
  defaultRenderersExtension,
  toastAppMountExtension,
  appUpdatePromptExtension,
  defaultEditorInteractionExtension,
  defaultActionContextsExtension,
  defaultActionsExtension({repo}),
]

/** Shape every `plugins/<name>/index.{ts,tsx}` must satisfy for discovery:
 *  a DEFAULT export of the plugin's `AppExtension` (or a `({repo}) =>
 *  AppExtension` factory for plugins whose action handlers close over
 *  `repo`), plus an optional `pluginOrder` (default 0) to override the
 *  alphabetical-by-path default where registration order matters (e.g.
 *  `app-intents` last; the settings meta-plugins first). */
interface PluginModule {
  default: AppExtension | ((ctx: {repo: Repo}) => AppExtension)
  pluginOrder?: number
}

// Auto-discovered plugin set — no hand-maintained import list. `import.meta.glob`
// is a Vite build-time transform (compiled to static imports; confirmed in the
// prod build, and already used by `authoringCatalog.ts`), so a new plugin is
// picked up just by dropping a `plugins/<name>/index.ts` with a default export.
const pluginModules = import.meta.glob<PluginModule>(
  '/src/plugins/*/index.{ts,tsx}',
  { eager: true },
)

const resolvePlugins = ({repo}: {repo: Repo}): AppExtension[] =>
  Object.entries(pluginModules)
    // Glob keys are alphabetical; sort by explicit order first, falling back
    // to path so the result is stable and deterministic. NOTE: because the
    // default is alphabetical, keyed/last-wins facet collisions (a renderer
    // id, action id, or value preset contributed by two plugins) now resolve
    // by (pluginOrder, path) — set an explicit `pluginOrder` on the plugin
    // that must win rather than relying on its path sorting later.
    .map(([path, mod]) => {
      // A missing default export would otherwise vanish silently from the
      // assembled app — fail loudly, naming the offending module instead.
      if (!mod.default) {
        throw new Error(
          `Plugin "${path}" has no default export — every ` +
          `plugins/<name>/index.{ts,tsx} must \`export default\` its ` +
          `AppExtension (or a ({repo}) => AppExtension factory).`,
        )
      }
      return {path, plugin: mod.default, order: mod.pluginOrder ?? 0}
    })
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
    // A function default is a `({repo}) => AppExtension` factory (no plugin is
    // a bare resolve-time function-node), so call it with `{repo}`; everything
    // else is already an `AppExtension`. The cast disambiguates from
    // `AppExtension`'s own function-node variant.
    .map(({plugin}) =>
      typeof plugin === 'function'
        ? (plugin as (ctx: {repo: Repo}) => AppExtension)({repo})
        : plugin,
    )

export const staticAppExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  ...coreExtensions({repo}),
  ...resolvePlugins({repo}),
]
