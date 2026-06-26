/**
 * First-run onboarding, expressed as a `workspaceLandingFacet` resolver —
 * the seam the kernel already hands `freshlyCreated` (its docstring calls
 * out "seed first-run affordances (a [[Tutorial]] bullet etc.)"). So there
 * is no bespoke kernel seeding hook: onboarding is just another landing
 * contributor.
 *
 * On a brand-new workspace it seeds the Tutorial / extensions pages and
 * drops a `[[Tutorial]]` discoverability bullet on today's daily note,
 * then returns `null` so the lower-precedence daily-notes resolver still
 * picks the actual landing block. On any non-fresh open it's a no-op.
 *
 * Registered at higher precedence than daily-notes so it runs FIRST in the
 * resolver walk: pages are seeded (and their alias rows committed) before
 * the bullet's references are parsed, and before daily-notes lands.
 *
 * Lives entirely in the onboarding plugin — disable it and a fresh
 * workspace gets neither the seeded pages nor the bullet (no kernel
 * seeding, no dangling `[[Tutorial]]` link). Depends on the daily-notes
 * plugin for the get-or-create of today's note.
 */
import type { WorkspaceLandingResolver } from '@/extensions/core.js'
import { getOrCreateDailyNote, todayIso } from '@/plugins/daily-notes/dailyNotes.js'
import { seedTutorial } from './seed.ts'

export const onboardingLanding: WorkspaceLandingResolver = async ({
  repo,
  workspaceId,
  freshlyCreated,
}) => {
  if (!freshlyCreated) return null

  // Seed pages first so the Tutorial alias row exists before the
  // discoverability bullet's references are parsed (post-commit) — the
  // ordering the old bootstrap call documented.
  await seedTutorial(repo, workspaceId)

  const dailyNote = await getOrCreateDailyNote(repo, workspaceId, todayIso())
  await repo.mutate.createChild({
    parentId: dailyNote.id,
    content: '[[Tutorial]]',
    position: { kind: 'first' },
  })

  // Defer the actual landing target to the daily-notes resolver.
  return null
}
