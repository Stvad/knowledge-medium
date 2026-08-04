/**
 * "Insert tutorial" command-palette action.
 *
 * The Tutorial is auto-seeded only on the user's first, freshly-created
 * workspace (see `landing.ts` — gated on `freshlyCreated`). Any later
 * workspace never gets it. This global action lets the user drop the
 * Tutorial subtree into the workspace they're viewing on demand, then
 * lands on it.
 */
import type { Repo } from '@/data/repo'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { activeWorkspaceIdPreferringHash, navigateFromGlobalCommand } from '@/utils/navigation.js'
import { showProgress } from '@/utils/toast.js'
import { GraduationCap } from 'lucide-react'
import { seedTutorial } from './seed.ts'
import { TUTORIAL_DEFAULT_TITLE } from './outline.ts'

export const INSERT_TUTORIAL_ACTION_ID = 'onboarding.insert_tutorial'

/**
 * Seed the Tutorial subtree into `workspaceId`, unless it already carries
 * a `Tutorial` page — re-seeding would mint a second page with the same
 * alias and leave `[[Tutorial]]` lookups ambiguous. The `block_aliases`
 * index is trigger-maintained (synchronous), so the guard sees a prior
 * seed immediately. Returns the default Tutorial page id (the existing
 * one when present) plus whether it was already there, so the caller can
 * route to it either way.
 */
export const insertTutorialIntoWorkspace = async (
  repo: Repo,
  workspaceId: string,
): Promise<{ tutorialId: string; alreadyExisted: boolean }> => {
  const existing = await repo.query
    .aliasLookup({ workspaceId, alias: TUTORIAL_DEFAULT_TITLE })
    .load()
  if (existing) return { tutorialId: existing.id, alreadyExisted: true }

  const tutorialId = await seedTutorial(repo, workspaceId)
  return { tutorialId, alreadyExisted: false }
}

/**
 * Seed-or-find the Tutorial in the active workspace and navigate to it.
 * Returns whether the user actually ended up on the tutorial.
 *
 * The boolean is the point, and it means NAVIGATED, not merely seeded — all
 * three ways this can fall short (no active workspace, a throwing seed, a
 * vetoed navigation) return false. Dispatching through the action system
 * cannot tell you any of that: the handler reports failure to the user as a
 * toast and then returns normally, so a dispatch resolves successfully
 * whether the tutorial opened or nothing happened at all.
 * Callers with something to undo on failure (the banner, which otherwise
 * burns its one-shot localStorage dismissal) need the truth, so the work
 * lives here and both entry points share it — the action stays the single
 * implementation, it just no longer launders the outcome.
 */
export const openTutorialInActiveWorkspace = async (repo: Repo): Promise<boolean> => {
  const workspaceId = activeWorkspaceIdPreferringHash(repo)
  if (!workspaceId) {
    showProgress('Insert tutorial').fail('Insert tutorial failed: no active workspace')
    return false
  }

  const banner = showProgress('Inserting tutorial…')
  try {
    const { tutorialId, alreadyExisted } = await insertTutorialIntoWorkspace(repo, workspaceId)
    banner.done(alreadyExisted ? 'Tutorial already present — opening it' : 'Tutorial inserted')
    // `navigateFromGlobalCommand` resolves `NavigationResult | null` and never
    // rejects — a vetoed/suppressed gesture comes back as `null`. Discarding it
    // would report success for a tutorial that was seeded but never opened,
    // which is the same lie this function exists to stop telling.
    const navigated = await navigateFromGlobalCommand(repo, { blockId: tutorialId, workspaceId })
    return navigated !== null
  } catch (err) {
    console.error('[onboarding] insert tutorial failed:', err)
    banner.fail(`Insert tutorial failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export const insertTutorialAction = ({
  repo,
}: {
  repo: Repo
}): ActionConfig<typeof ActionContextTypes.GLOBAL> => ({
  id: INSERT_TUTORIAL_ACTION_ID,
  description: 'Insert tutorial',
  context: ActionContextTypes.GLOBAL,
  icon: GraduationCap,
  // Swallows the result deliberately: the palette has nothing to roll back,
  // and rejecting here would surface as an unhandled rejection on every
  // fire-and-forget dispatch path.
  handler: async () => {
    await openTutorialInActiveWorkspace(repo)
  },
})
