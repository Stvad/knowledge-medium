/** Runtime stand-in for the app's `@/components/ui/button.js`.
 *
 *  `@/` normally resolves to declaration-only stubs, so a module that merely
 *  IMPORTS a UI-kit component (`startAction` → `StartSessionDialog`) fails to
 *  load at all without one of these. Faithful in the only way a test can read:
 *  it is a real `<button>` carrying the label and the click handler.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

import type {ComponentProps} from 'react'

export const Button = (
  {variant: _variant, size: _size, ...props}: ComponentProps<'button'> & {
    variant?: string
    size?: string
  },
) => <button type="button" {...props}/>
