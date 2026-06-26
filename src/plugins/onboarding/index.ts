/**
 * Onboarding plugin — seeds the starter Tutorial into a brand-new
 * workspace. Formerly kernel code (`src/initData.ts` + `src/tutorial/`)
 * called directly from `workspaceBootstrap`; now a normal, toggleable
 * plugin that contributes a `workspaceLandingFacet` resolver (see
 * `landing.ts`). Being a plugin lets it depend on other plugins
 * (daily-notes) and keeps first-run content out of the kernel.
 */
import { systemToggle } from '@/facets/togglable.js'
import { workspaceLandingFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { onboardingLanding } from './landing.ts'

// The seeded tutorial tags demo blocks with the todo / char-counter / srs /
// place / map types. The seed runs at bootstrap (before the app runtime is
// applied), so it reads those types from `repo.snapshotTypeRegistries()` —
// which is populated from `staticDataExtensions`, where those plugins' data
// extensions are registered. That's the dependency; it isn't re-declared here.
export const onboardingPlugin: AppExtension = systemToggle({
  id: 'system:onboarding',
  name: 'Onboarding',
  description: 'Seeds the starter Tutorial pages and a [[Tutorial]] bullet into a brand-new workspace.',
}).of([
  // Higher precedence than daily-notes (default) so it seeds before the
  // daily-notes resolver lands; returns null to defer the landing target.
  workspaceLandingFacet.of(onboardingLanding, { source: 'onboarding', precedence: 10 }),
])

export { seedTutorial } from './seed.ts'
export {
  TUTORIAL_DEFAULT_TITLE,
  TUTORIAL_VIM_TITLE,
  EXTENSIONS_PAGE_TITLE,
} from './outline.ts'
