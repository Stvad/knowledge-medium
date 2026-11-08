/** Runtime stand-in for the app's `@/shortcuts/types.js`.
 *
 *  `ActionContextTypes` is a runtime VALUE that the kernel-type stubs can only
 *  declare, so any `src/` module registering an action — `startAction.ts` —
 *  cannot be imported at all under the unit tier without this. It is a frozen
 *  string map with no behaviour, so a copy is faithful by construction; the
 *  values are asserted against the real ones in `startAction.test.ts` rather
 *  than trusted.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

export const ActionContextTypes = {
  GLOBAL: 'global',
  NORMAL_MODE: 'normal-mode',
  EDIT_MODE_CM: 'edit-mode-cm',
  PROPERTY_EDITING: 'property-editing',
  MULTI_SELECT_MODE: 'multi-select-mode',
  BLOCK_POINTER: 'block-pointer',
} as const
