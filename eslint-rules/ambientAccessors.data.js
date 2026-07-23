// Table of ambient-accessor restrictions consumed by
// eslint-rules/ambient-accessors.js. Each entry bans one import / member
// read / literal outside an explicit allowlist. This is the generic
// mechanism the DI-lens audit (PR #357 / PR #424) promised as a follow-up:
// replace one-off eslint.config.js entries (a new no-restricted-imports
// path or no-restricted-syntax selector per ambient global) with a single
// rule driven by this table, so adding a restriction is a table edit — or,
// for a tagged export, not even that (see the generator below).
//
// Two sections:
//
//   - `generatedEntries` — GENERATED, do not edit; run
//     `pnpm run gen:ambient-accessors`. Populated from `@ambient` JSDoc
//     tags on exported declarations in src/. See
//     scripts/gen-ambient-accessors.ts for the tag grammar. Example: tag
//     `getActiveUserId` in src/data/repoProvider.ts and the generator
//     regenerates its entry here — no eslint.config.js edit, no new rule
//     instance. (The un-merged getLayoutSessionId follow-up from PR #425
//     is exactly this: tag the export, regenerate, done — see
//     src/data/repoProvider.ts's comment on getActiveUserId for the
//     pattern to copy.)
//
//   - `manualEntries` — hand-maintained. For restrictions that aren't a
//     tagged export: browser globals (`navigator.platform`) and literals
//     (the mobile breakpoint string) have no JSDoc-taggable declaration to
//     hang the policy on, so their entries live here directly.
//
// Entry shapes (see ambient-accessors.js for full matching semantics):
//   {kind:'import',  module, names,          message, allowIn}
//   {kind:'member',  object, property,       message, allowIn}
//   {kind:'literal', value,                  message, allowIn}
//
// `allowIn` is a list of repo-relative file paths matched by suffix
// (mirrors block-subscriptions.js's isAllowedFile) — the only files
// allowed to trigger the pattern.

// --- BEGIN GENERATED ambientAccessors (do not edit; run `pnpm run gen:ambient-accessors`) ---
export const generatedEntries = [
  {
    kind: 'import',
    module: '@/data/repoProvider',
    names: ['getActiveUserId'],
    message: 'getActiveUserId() reads the ambient active-user global. Use the injected channel instead: repo.user.id (a Repo/Block is already in scope at every call site) or useUser() in a component.',
    allowIn: [
      'src/data/repoProvider.ts',
      'src/plugins/attachments/assetUpload.ts',
      'src/plugins/attachments/assetResolver.ts',
    ],
  },
]
// --- END GENERATED ambientAccessors ---

export const manualEntries = [
  {
    kind: 'member',
    object: 'navigator',
    property: 'platform',
    message:
      'navigator.platform is read directly outside the shared platform module. Use isMacPlatform() from @/utils/platform.js (or add a new accessor there) so every Mac/platform check agrees — see the DI-lens audit (PR #357).',
    allowIn: [
      'src/utils/platform.ts',
      'src/plugins/startup-metrics/record.ts',
    ],
  },
  {
    kind: 'literal',
    value: '(max-width: 767px)',
    message:
      'The mobile breakpoint is duplicated outside the shared viewport module. Use MOBILE_BREAKPOINT_QUERY / isMobileViewport from @/utils/viewport.js, or useIsMobile from @/utils/react.js in a component — see the DI-lens audit (PR #357).',
    allowIn: ['src/utils/viewport.ts'],
  },
]
