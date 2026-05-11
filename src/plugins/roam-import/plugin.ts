/**
 * Roam Research importer plugin.
 *
 * Contributes:
 *   - `import_roam` global action — surfaces the file-picker UI and
 *     drives the importer through `progressBanner` updates.
 *   - `roamImportWindowHookEffect` — installs the idempotent
 *     `window.__omniliner.roamImport` debug hook once the Repo is
 *     available, so agent-runtime scripts can call `importRoam`
 *     without going through the file picker.
 *
 * The bulk of the implementation (planner, writer, content rewriter,
 * SRS / todo / page-property reconciliation, progress banner) lives in
 * sibling files under `src/plugins/roam-import/`. They were lifted
 * out of `src/utils/roamImport/` so the importer is fully owned by
 * this plugin.
 */
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/extensions/facet.ts'
import { actionsFacet, appEffectsFacet } from '@/extensions/core.ts'
import { importRoamAction } from './action.ts'
import { roamImportWindowHookEffect } from './effect.ts'

export const roamImportPlugin = ({repo}: {repo: Repo}): AppExtension => [
  actionsFacet.of(importRoamAction({repo}), {source: 'roam-import'}),
  appEffectsFacet.of(roamImportWindowHookEffect, {source: 'roam-import'}),
]
