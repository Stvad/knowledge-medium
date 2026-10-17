/**
 * `window.__omniliner`: the one global slot the devtools-console and agent
 * hooks share. Each owner adds its own key by augmenting `OmnilinerNamespace`
 * from its own module, so no module needs another's shape — and core never
 * has to see a plugin's declaration to type the slot.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by module augmentation
export interface OmnilinerNamespace {}

declare global {
  interface Window {
    __omniliner?: OmnilinerNamespace
  }
}

/** The shared namespace object, created on first use. */
export const omnilinerNamespace = (): OmnilinerNamespace => (window.__omniliner ??= {})
