/**
 * Publish point that bridges the per-provider approval store into the global
 * status-chip diagnostic.
 *
 * The trust statuses live in a per-`AppRuntimeProvider` `ExtensionApproval-
 * StatusStore` (recreated per workspace, read via React context). The status
 * chip's diagnostic source, by contrast, is a static facet contribution with
 * no React context to reach that store. So the driver mount (which DOES have
 * the context) computes the pending prompt set and publishes it here; the
 * diagnostic reads this singleton.
 *
 * `pendingExtensionPrompts` is the pure reducer both surfaces share. It emits
 * EVERY pending (enabled-but-not-running) extension, tagged with whether the
 * user has `dismissed` its prompt for the current source version. The two
 * surfaces then read that flag differently, which is the whole dismiss model:
 *   - the toast shows only the NON-dismissed prompts (dismiss silences the nag)
 *   - the chip shows ALL of them as a quiet dropdown row, but only nudges (the
 *     ambient dot) while at least one is non-dismissed — so a dismissed prompt
 *     stays discoverable without nagging.
 */
import {CallbackSet} from '@/utils/callbackSet.js'
import type {ExtensionApprovalStatusMap} from '@/extensions/extensionApprovalStatus.js'
import type {DismissalMap} from '@/extensions/extensionPromptDismissals.js'

export interface PendingExtensionPrompt {
  blockId: string
  name: string
  kind: 'needs-approval' | 'update-available'
  /** The live source hash this prompt is about — the key a dismissal pins
   *  to, so a later source change re-surfaces the prompt. */
  liveHash: string
  /** Whether the user dismissed THIS prompt (this blockId + this liveHash).
   *  Keyed per blockId: dismissing extension A never sets B's flag. */
  dismissed: boolean
}

/**
 * Reduce the raw trust-status map to every pending prompt, tagging each with
 * whether it's been dismissed for its current source version.
 *
 * The dismissal check is `dismissals[blockId] === status.liveHash`, keyed per
 * blockId — the fix for the mis-keyed dismissal: dismissing extension A tags
 * ONLY A (and only while A's source is unchanged); B is never affected.
 */
export const pendingExtensionPrompts = (
  statuses: ExtensionApprovalStatusMap,
  dismissals: DismissalMap,
): PendingExtensionPrompt[] => {
  const out: PendingExtensionPrompt[] = []
  for (const [blockId, status] of statuses) {
    out.push({
      blockId,
      name: status.name,
      kind: status.kind,
      liveHash: status.liveHash,
      dismissed: dismissals[blockId] === status.liveHash,
    })
  }
  return out
}

const samePrompts = (
  a: readonly PendingExtensionPrompt[],
  b: readonly PendingExtensionPrompt[],
): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.blockId !== y.blockId ||
      x.kind !== y.kind ||
      x.liveHash !== y.liveHash ||
      x.name !== y.name ||
      x.dismissed !== y.dismissed
    ) {
      return false
    }
  }
  return true
}

class ExtensionPromptStore {
  private prompts: readonly PendingExtensionPrompt[] = []
  private readonly listeners = new CallbackSet('ExtensionPromptStore')

  getSnapshot = (): readonly PendingExtensionPrompt[] => this.prompts

  subscribe = (listener: () => void): (() => void) => this.listeners.add(listener)

  /** Replace the published set. Dedupes by content (including the `dismissed`
   *  flag) so the snapshot ref stays referentially stable (a
   *  `useSyncExternalStore` requirement) whenever the driver re-publishes an
   *  unchanged set — while still updating when a dismissal flips the dot. */
  set = (next: readonly PendingExtensionPrompt[]): void => {
    if (samePrompts(this.prompts, next)) return
    this.prompts = next
    this.listeners.notify()
  }
}

export const extensionPromptStore = new ExtensionPromptStore()
