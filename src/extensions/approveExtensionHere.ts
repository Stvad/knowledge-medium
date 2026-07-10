/**
 * Approve (or re-approve) a user extension on THIS device: pin its live
 * source so the loader will run it. This is the EXPLICIT device-local trust
 * action shared by every "Enable here" / "Update" affordance — the settings
 * toggle rows (`ExtensionsOverridesEditor`) AND the global prompt toast
 * (`extensionPromptMount`).
 *
 * Keyed strictly by `blockId`: it loads THAT block's current content and
 * approves THAT block. Nothing here is shared across extensions, so enabling
 * one extension can never touch another's trust state — the guarantee the
 * global surface needs to avoid the mis-keyed-dismissal bug.
 *
 * Returns whether trust was established. Surfaces a toast on failure (store
 * unreadable / block missing / approval write failed) so callers can avoid
 * setting "enabled" intent against a non-existent approval (which would
 * silently loop on needs-approval — #67 review).
 *
 * Fails closed when the device-local approval store is UNREADABLE. The loader
 * reports `needs-approval` on a transient approval-read failure too
 * (`readApproval` can't tell "no approval" from "couldn't read"), so the
 * prompt that led here may be masking an EXISTING trusted pin — blindly
 * approving would overwrite it with the (possibly drifted) live source.
 * `lookupApproval` distinguishes the cases; we only pin when the store is
 * genuinely readable. This matches the settings checkbox enable path.
 */
import {
  approveExtension,
  lookupApproval,
} from '@/extensions/compileExtensionModule.js'
import type {Repo} from '@/data/repo'
import {showError} from '@/utils/toast.js'

export const approveExtensionHere = async (
  repo: Repo,
  blockId: string,
  name: string,
): Promise<boolean> => {
  try {
    // Fail closed on an unreadable approval store (see the header) — before
    // loading or writing anything.
    if ((await lookupApproval(blockId)).status === 'unreadable') {
      showError(
        `Couldn't enable "${name}" — couldn't read its approval state. Try again.`,
      )
      return false
    }
    // The block load is inside the try too: a transient DB read failure must
    // resolve to `false` + a toast like every other failure, not reject —
    // callers only handle the resolved-false path (the global prompt's
    // `void approve(...).then(...)` would otherwise turn it into an unhandled
    // rejection and drop the retry affordance).
    const block = await repo.load(blockId)
    if (!block) {
      showError(`Couldn't enable "${name}" — its definition block wasn't found.`)
      return false
    }
    await approveExtension(blockId, block.content ?? '')
    return true
  } catch (error) {
    console.error(`Failed to approve extension ${blockId}`, error)
    showError(
      `Couldn't enable "${name}" — ${
        error instanceof Error ? error.message : 'approval could not be saved'
      }.`,
    )
    return false
  }
}
